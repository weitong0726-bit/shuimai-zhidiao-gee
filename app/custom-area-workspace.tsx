'use client';

import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import {
  AlertCircle,
  CheckCircle2,
  CloudDownload,
  Cloudy,
  Copy,
  FileArchive,
  FileJson,
  KeyRound,
  LoaderCircle,
  MapPinned,
  Play,
  Satellite,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react';

type Position = [number, number];
type PolygonCoordinates = Position[][];
type MultiPolygonCoordinates = PolygonCoordinates[];
type PolygonGeometry = { type: 'Polygon'; coordinates: PolygonCoordinates };
type MultiPolygonGeometry = { type: 'MultiPolygon'; coordinates: MultiPolygonCoordinates };
type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;
type AreaFeature = { type: 'Feature'; properties: Record<string, unknown> & { id: string }; geometry: AreaGeometry };
type AreaCollection = { type: 'FeatureCollection'; features: AreaFeature[] };
type RawFeature = { type?: string; properties?: Record<string, unknown> | null; geometry?: { type?: string; coordinates?: unknown } | null };
type RawCollection = { type?: string; features?: RawFeature[]; fileName?: string };

type AreaSummary = {
  fileName: string;
  collection: AreaCollection;
  bbox: [number, number, number, number];
  areaKm2: number;
  centroid: Position;
  crs: string;
};

type GeeIndex = 'RGB' | 'NDVI' | 'NDMI' | 'MNDWI';
type GeeResult = {
  imageUrl: string;
  index: GeeIndex;
  sceneCount: number;
  mean: number | null;
  generatedAt: string;
};

type EarthEngineApi = {
  reset?: () => void;
  data: {
    authenticateViaOauth: (...args: unknown[]) => void;
    authenticateViaPopup: (...args: unknown[]) => void;
  };
  initialize: (...args: unknown[]) => void;
  FeatureCollection: (value: unknown) => EarthEngineObject;
  ImageCollection: (assetId: string) => EarthEngineObject;
  Filter: { lt: (property: string, value: number) => unknown };
  Reducer: { mean: () => unknown };
};

type EarthEngineObject = {
  [key: string]: (...args: unknown[]) => EarthEngineObject;
};

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PUBLIC_SITE_ORIGIN = 'https://shuimai-zhidiao.weitong0726.chatgpt.site';
let earthEngineLoader: Promise<EarthEngineApi> | null = null;

function loadEarthEngine() {
  if (!earthEngineLoader) {
    earthEngineLoader = import('@google/earthengine').then((module) => {
      const candidate = (module as unknown as { default?: EarthEngineApi }).default;
      return candidate ?? (module as unknown as EarthEngineApi);
    });
  }
  return earthEngineLoader;
}

function geeErrorMessage(cause: unknown) {
  let message = '未知错误';
  if (cause instanceof Error) message = cause.message;
  else if (typeof cause === 'string') message = cause;
  else if (cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string') message = cause.message;
  if (/origin|client|oauth|idpiframe/i.test(message)) return `OAuth配置不匹配：请把 ${window.location.origin} 加入该客户端ID的“已获授权的JavaScript来源”。`;
  if (/popup|window|cancel|closed/i.test(message)) return '授权窗口被浏览器拦截或已关闭。请允许本站弹出窗口，然后再次点击“授权并连接GEE”。';
  if (/403|permission|not registered|not authorized/i.test(message)) return '当前账号或项目没有Earth Engine权限。请确认该项目已启用Earth Engine API，并已完成Earth Engine注册。';
  if (/429|quota/i.test(message)) return 'GEE请求额度暂时不足，请稍后再试或更换有额度的Cloud项目。';
  return `GEE请求失败：${message}`;
}

function evaluateGee<T>(object: EarthEngineObject) {
  return new Promise<T>((resolve, reject) => {
    object.evaluate((value: unknown, error: unknown) => error ? reject(error) : resolve(value as T));
  });
}

function thumbUrl(image: EarthEngineObject, params: Record<string, unknown>) {
  return new Promise<string>((resolve, reject) => {
    image.getThumbURL(params, (url: unknown, error: unknown) => {
      if (error) reject(error);
      else if (typeof url === 'string' && url) resolve(url);
      else reject(new Error('GEE没有返回影像地址。'));
    });
  });
}

function collectPositions(value: unknown, output: Position[]) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    output.push([value[0], value[1]]);
    return;
  }
  value.forEach((item) => collectPositions(item, output));
}

function ringAreaKm2(ring: Position[], latitude: number) {
  if (ring.length < 3) return 0;
  const xScale = 111.32 * Math.cos(latitude * Math.PI / 180);
  const yScale = 110.574;
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    sum += current[0] * xScale * next[1] * yScale - next[0] * xScale * current[1] * yScale;
  }
  return Math.abs(sum) / 2;
}

function geometryAreaKm2(geometry: AreaGeometry, latitude: number) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((total, polygon) => {
    if (!polygon.length) return total;
    const outer = ringAreaKm2(polygon[0], latitude);
    const holes = polygon.slice(1).reduce((sum, ring) => sum + ringAreaKm2(ring, latitude), 0);
    return total + Math.max(0, outer - holes);
  }, 0);
}

function normalizeCollection(raw: unknown, fileName: string): AreaSummary {
  const candidates = Array.isArray(raw) ? raw : [raw];
  const rawFeatures = candidates.flatMap((item) => {
    const collection = item as RawCollection;
    return collection?.type === 'FeatureCollection' && Array.isArray(collection.features) ? collection.features : [];
  });
  const usedIds = new Set<string>();
  const features: AreaFeature[] = [];
  rawFeatures.forEach((feature, index) => {
    if (!feature.geometry || (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon')) return;
    const positions: Position[] = [];
    collectPositions(feature.geometry.coordinates, positions);
    if (positions.length < 4 || positions.some(([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat))) return;
    const properties = { ...feature.properties };
    const rawId = properties.id ?? properties.ID ?? properties.name ?? properties.NAME;
    const requestedId = (typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : '') || `U${index + 1}`;
    let id = requestedId.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || `U${index + 1}`;
    while (usedIds.has(id)) id = `${id}_${index + 1}`;
    usedIds.add(id);
    features.push({
      type: 'Feature',
      properties: { ...properties, id },
      geometry: feature.geometry as AreaGeometry,
    });
  });
  if (!features.length) throw new Error('没有识别到Polygon或MultiPolygon面要素。请上传面状研究区，而不是点或线。');
  if (features.length > 100) throw new Error('面要素超过100个。请先合并或筛选研究区，避免GEE任务过大。');
  const positions: Position[] = [];
  features.forEach((feature) => collectPositions(feature.geometry.coordinates, positions));
  const minLon = Math.min(...positions.map((point) => point[0]));
  const maxLon = Math.max(...positions.map((point) => point[0]));
  const minLat = Math.min(...positions.map((point) => point[1]));
  const maxLat = Math.max(...positions.map((point) => point[1]));
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw new Error('坐标不是WGS84经纬度。Shapefile压缩包中必须包含正确的.prj文件。');
  }
  const centroid: Position = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const areaKm2 = features.reduce((sum, feature) => sum + geometryAreaKm2(feature.geometry, centroid[1]), 0);
  const zone = Math.max(1, Math.min(60, Math.floor((centroid[0] + 180) / 6) + 1));
  const crs = `EPSG:${centroid[1] >= 0 ? 32600 + zone : 32700 + zone}`;
  return { fileName, collection: { type: 'FeatureCollection', features }, bbox: [minLon, minLat, maxLon, maxLat], areaKm2, centroid, crs };
}

function geometryPaths(summary: AreaSummary) {
  const [minLon, minLat, maxLon, maxLat] = summary.bbox;
  const width = Math.max(maxLon - minLon, 0.000001);
  const height = Math.max(maxLat - minLat, 0.000001);
  const scale = Math.min(720 / width, 390 / height);
  const offsetX = (800 - width * scale) / 2;
  const offsetY = (450 - height * scale) / 2;
  const point = ([lon, lat]: Position) => `${offsetX + (lon - minLon) * scale},${450 - offsetY - (lat - minLat) * scale}`;
  return summary.collection.features.flatMap((feature, featureIndex) => {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    return polygons.map((polygon, polygonIndex) => ({
      key: `${featureIndex}-${polygonIndex}`,
      id: feature.properties.id,
      d: polygon.map((ring) => `${ring.map((position, index) => `${index ? 'L' : 'M'}${point(position)}`).join(' ')} Z`).join(' '),
    }));
  });
}

function downloadText(fileName: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function makeGeeScript(summary: AreaSummary, start: string, end: string, periodDays: number) {
  const response = await fetch('/gee-wetland-observations.js');
  if (!response.ok) throw new Error('无法读取GEE脚本模板。');
  let script = await response.text();
  const unitsCode = `var units = ee.FeatureCollection(${JSON.stringify(summary.collection)});`;
  script = script.replace(/\/\/ H1\/H2坐标来自[\s\S]*?\/\/ 每个feature必须有唯一id，且多边形不得重叠。/, '// 用户上传的WGS84面状研究区；网站已补充唯一id。\n// 首次运行仍需在卫星底图核查地类、边界与供水连通性。');
  script = script.replace(/var units = ee\.FeatureCollection\(\[[\s\S]*?\n\]\);/, unitsCode);
  script = script.replace("var START = '2025-06-01';", `var START = '${start}';`);
  script = script.replace("var END = '2025-07-01';", `var END = '${end}';`);
  script = script.replace('var PERIOD_DAYS = 7;', `var PERIOD_DAYS = ${periodDays};`);
  script = script.replace("var CRS = 'EPSG:32649';", `var CRS = '${summary.crs}';`);
  script = script.replace(/maxPixels:1e7/g, 'maxPixels:1e9').replace('maxPixels:1e8', 'maxPixels:1e13');
  script = script.replace(/H1\/H2/g, '用户研究单元').replace(/H1和H2/g, '用户研究单元');
  return script;
}

export function CustomAreaWorkspace() {
  const [summary, setSummary] = useState<AreaSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState('2025-06-01');
  const [end, setEnd] = useState('2025-07-01');
  const periodDays = 7;
  const [projectId, setProjectId] = useState(() => typeof window === 'undefined' ? '' : window.localStorage.getItem('shuimai_gee_project') || '');
  const [oauthClientId, setOauthClientId] = useState(() => typeof window === 'undefined' ? '' : window.localStorage.getItem('shuimai_gee_client') || '');
  const [geeIndex, setGeeIndex] = useState<GeeIndex>('NDMI');
  const [geeConnected, setGeeConnected] = useState(false);
  const [geeBusy, setGeeBusy] = useState<'connect' | 'analyse' | ''>('');
  const [connectAttempted, setConnectAttempted] = useState(false);
  const [geeConnectMessage, setGeeConnectMessage] = useState('');
  const [geeAnalysisMessage, setGeeAnalysisMessage] = useState('');
  const [geeResult, setGeeResult] = useState<GeeResult | null>(null);
  const eeRef = useRef<EarthEngineApi | null>(null);
  const paths = useMemo(() => summary ? geometryPaths(summary) : [], [summary]);

  useEffect(() => {
    void loadEarthEngine();
  }, []);

  async function importBoundary(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error('文件超过25MB，请先简化边界或减少要素。');
      let parsed: unknown;
      if (file.name.toLowerCase().endsWith('.zip')) {
        const shp = (await import('shpjs')).default;
        parsed = await shp(await file.arrayBuffer());
      } else {
        parsed = JSON.parse(await file.text());
      }
      setSummary(normalizeCollection(parsed, file.name));
      setGeeResult(null);
    } catch (cause) {
      setSummary(null);
      setError(cause instanceof Error ? cause.message : '边界读取失败。');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function connectGee() {
    setConnectAttempted(true);
    if (!summary) {
      setGeeConnectMessage('请先导入研究区边界。');
      return;
    }
    if (!projectId.trim() || !oauthClientId.trim()) {
      const missing = [!projectId.trim() ? 'Google Cloud项目ID' : '', !oauthClientId.trim() ? 'OAuth网页客户端ID' : ''].filter(Boolean).join('和');
      setGeeConnectMessage(`还不能连接：请先填写${missing}。这两项为空时，网站无法向Google发起授权。`);
      return;
    }
    setGeeBusy('connect');
    setGeeConnectMessage('正在加载Google授权窗口，请在弹窗中选择已开通GEE的账号…');
    setGeeAnalysisMessage('');
    setGeeResult(null);
    try {
      const ee = await loadEarthEngine();
      ee.reset?.();
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('授权窗口等待超时。')), 45000);
        const finish = () => { window.clearTimeout(timer); resolve(); };
        const fail = (cause: unknown) => { window.clearTimeout(timer); reject(cause); };
        const initialize = () => ee.initialize(null, null, finish, fail, null, projectId.trim());
        ee.data.authenticateViaOauth(
          oauthClientId.trim(),
          initialize,
          fail,
          ['https://www.googleapis.com/auth/earthengine.readonly'],
          () => ee.data.authenticateViaPopup(initialize, fail),
        );
      });
      eeRef.current = ee;
      window.localStorage.setItem('shuimai_gee_project', projectId.trim());
      window.localStorage.setItem('shuimai_gee_client', oauthClientId.trim());
      setGeeConnected(true);
      setGeeConnectMessage('GEE连接成功。现在可以进入第3步读取当前边界内的遥感数据。');
    } catch (cause) {
      setGeeConnected(false);
      setGeeConnectMessage(geeErrorMessage(cause));
    } finally {
      setGeeBusy('');
    }
  }

  async function runGeeAnalysis() {
    if (!summary || !eeRef.current || !geeConnected) {
      setGeeAnalysisMessage('请先完成第2步的Google Earth Engine授权。');
      return;
    }
    if (!start || !end || start >= end) {
      setGeeAnalysisMessage('结束日期必须晚于开始日期。');
      return;
    }
    setGeeBusy('analyse');
    setGeeAnalysisMessage('正在检索Sentinel-2并计算区域结果…');
    setGeeResult(null);
    try {
      const ee = eeRef.current;
      const units = ee.FeatureCollection(summary.collection);
      const region = units.geometry();
      const collection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 60));
      const sceneCount = await evaluateGee<number>(collection.size());
      if (!sceneCount) throw new Error('所选时段没有满足条件的Sentinel-2影像，请扩大日期范围。');
      const composite = collection.median().clip(region);
      let image = composite;
      let visualization: Record<string, unknown> = { bands: ['B4', 'B3', 'B2'], min: 0, max: 3000, gamma: 1.15 };
      if (geeIndex === 'NDVI') {
        image = composite.normalizedDifference(['B8', 'B4']).rename('NDVI');
        visualization = { min: -0.3, max: 0.85, palette: ['7f3b08', 'f6e8c3', '90c987', '075c37'] };
      } else if (geeIndex === 'NDMI') {
        image = composite.normalizedDifference(['B8', 'B11']).rename('NDMI');
        visualization = { min: -0.5, max: 0.65, palette: ['8c510a', 'f6e8c3', '80cdc1', '01665e'] };
      } else if (geeIndex === 'MNDWI') {
        image = composite.normalizedDifference(['B3', 'B11']).rename('MNDWI');
        visualization = { min: -0.6, max: 0.7, palette: ['a6611a', 'f5f5f5', '4393c3', '053061'] };
      }
      const imageUrl = await thumbUrl(image, {
        ...visualization,
        region,
        dimensions: '1000x700',
        format: 'png',
      });
      let mean: number | null = null;
      if (geeIndex !== 'RGB') {
        const stats = await evaluateGee<Record<string, unknown>>(image.reduceRegion({
          reducer: ee.Reducer.mean(),
          geometry: region,
          scale: 20,
          bestEffort: true,
          maxPixels: 1e9,
        }));
        const value = stats[geeIndex];
        mean = typeof value === 'number' ? value : null;
      }
      setGeeResult({ imageUrl, index: geeIndex, sceneCount, mean, generatedAt: new Date().toLocaleString('zh-CN') });
      setGeeAnalysisMessage(`分析完成：共使用${sceneCount}景Sentinel-2影像。`);
    } catch (cause) {
      setGeeAnalysisMessage(geeErrorMessage(cause));
    } finally {
      setGeeBusy('');
    }
  }

  async function copySiteOrigin() {
    try {
      await navigator.clipboard.writeText(PUBLIC_SITE_ORIGIN);
      setGeeConnectMessage('网站来源已复制。请粘贴到OAuth客户端的“已获授权的JavaScript来源”。');
    } catch {
      setGeeConnectMessage(`请手动复制网站来源：${PUBLIC_SITE_ORIGIN}`);
    }
  }

  async function downloadGeeScript() {
    if (!summary) return;
    setBusy(true);
    setError('');
    try {
      const script = await makeGeeScript(summary, start, end, periodDays);
      downloadText('shuimai_custom_area_gee.js', script, 'text/javascript;charset=utf-8');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '脚本生成失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="custom-area" className="min-h-screen bg-[#edf0e9] py-8 lg:py-12">
      <div className="mx-auto max-w-7xl px-5 lg:px-8">
        <header className="mb-9 flex flex-wrap items-center justify-between gap-4 border-b border-[#c8c4b8] pb-5">
          <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-lg bg-[#d9aa45] text-[#17332f]"><MapPinned className="size-5"/></span><div><strong className="block text-base tracking-[.16em] text-[#173d38]">水脉智调</strong><span className="mt-1 block text-xs text-[#65766f]">研究区边界导入工具</span></div></div>
          <span className="rounded-full border border-[#a8beb7] bg-white/60 px-3 py-1.5 text-xs text-[#45675f]">所有文件仅在当前浏览器处理</span>
        </header>
        <div className="grid gap-5 lg:grid-cols-[1fr_.78fr] lg:items-end">
          <div><div className="mb-3 flex items-center gap-2 text-xs font-medium tracking-[.16em] text-[#9b6a12]"><span className="h-px w-8 bg-current"/>START HERE</div><h1 className="max-w-3xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">导入边界，直接读取GEE影像</h1></div>
          <p className="max-w-xl text-sm leading-7 text-[#5c6b67]">上传自己的研究区，授权Google Earth Engine后，可在当前页面检索Sentinel-2并计算真彩色、NDVI、NDMI或MNDWI结果。</p>
        </div>

        <div className="mt-8 grid overflow-hidden rounded-xl border border-[#bdb7a9] bg-[#fffef9] shadow-sm lg:grid-cols-[360px_1fr]">
          <aside className="bg-[#123d38] p-6 text-white">
            <div className="flex items-center gap-3"><FileArchive className="size-6 text-[#e0b957]"/><div><p className="text-xs text-[#a9c5be]">BOUNDARY INTAKE</p><h3 className="mt-1 text-xl font-semibold">上传研究区边界</h3></div></div>
            <div className="mt-6 rounded-lg border border-white/15 bg-white/5 p-4 text-sm leading-6 text-[#d2e1dd]"><b className="text-white">Shapefile请先压缩为ZIP</b><br/>同名的.shp、.shx、.dbf、.prj放在压缩包根目录；缺少.prj可能导致坐标无法转换。</div>
            <label className="mt-5 flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-[#d9aa45] px-4 py-3 text-sm font-semibold text-[#17332f] hover:bg-[#e5ba5c]">
              {busy ? <LoaderCircle className="size-4 animate-spin"/> : <UploadCloud className="size-4"/>}选择ZIP或GeoJSON
              <input className="sr-only" type="file" accept=".zip,.geojson,.json,application/zip,application/geo+json,application/json" onChange={importBoundary}/>
            </label>
            <p className="mt-3 text-xs leading-5 text-[#9ebbb4]">最多25MB、100个面要素。点和线文件不会进入分析。</p>
            <ol className="mt-6 space-y-3 border-t border-white/10 pt-5 text-xs leading-5 text-[#c7dad5]">
              <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full border border-[#d9aa45] text-[#edc86f]">1</span><span>上传并确认研究区边界</span></li>
              <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full border border-white/25">2</span><span>用自己的Google账号连接GEE</span></li>
              <li className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full border border-white/25">3</span><span>选择指标并读取区域影像</span></li>
            </ol>
            {error && <p role="alert" className="mt-4 flex gap-2 rounded-md bg-[#7a2f25]/40 p-3 text-xs leading-5 text-[#ffd5cc]"><AlertCircle className="mt-0.5 size-4 shrink-0"/>{error}</p>}
            {summary && <div className="mt-5 border-t border-white/10 pt-5"><p className="flex items-center gap-2 text-sm text-[#aee0ca]"><CheckCircle2 className="size-4"/>边界读取成功</p><dl className="mt-3 space-y-2 text-xs"><div className="flex justify-between gap-3"><dt className="text-[#9ebbb4]">文件</dt><dd className="max-w-48 truncate">{summary.fileName}</dd></div><div className="flex justify-between"><dt className="text-[#9ebbb4]">面要素</dt><dd>{summary.collection.features.length}个</dd></div><div className="flex justify-between"><dt className="text-[#9ebbb4]">估算面积</dt><dd>{summary.areaKm2.toFixed(2)} km²</dd></div><div className="flex justify-between"><dt className="text-[#9ebbb4]">建议投影</dt><dd>{summary.crs}</dd></div></dl></div>}
          </aside>

          <div className="min-w-0 p-6 lg:p-8">
            {!summary ? <div className="grid min-h-[510px] place-items-center rounded-lg border border-dashed border-[#b7b1a4] bg-[#f7f6f1] text-center"><div className="max-w-md px-6"><MapPinned className="mx-auto size-10 text-[#73928a]"/><h3 className="mt-5 text-xl font-semibold">等待研究区文件</h3><p className="mt-3 text-sm leading-7 text-[#687873]">上传后将在这里预览面边界、检查WGS84坐标范围，并为每个面生成唯一分析ID。</p></div></div> : <div>
              <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs text-[#687873]">第1步 · 自定义研究区已就绪</p><h3 className="mt-1 text-2xl font-semibold">边界预览</h3></div><button className="flex items-center gap-2 rounded-md border border-[#8eb8ab] px-3 py-2 text-sm font-medium text-[#205f52]" onClick={() => downloadText('shuimai_custom_area.geojson', JSON.stringify(summary.collection, null, 2), 'application/geo+json')}><FileJson className="size-4"/>下载标准化GeoJSON</button></div>
              <div className="mt-5 overflow-hidden rounded-lg border border-[#c8c4b8] bg-[#e8eee9]"><svg viewBox="0 0 800 450" className="h-auto max-h-[390px] w-full" aria-label="用户上传研究区边界预览"><title>用户上传研究区边界预览</title><defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#b9c9c2" strokeWidth="1"/></pattern></defs><rect width="800" height="450" fill="url(#grid)"/>{paths.map((path) => <path key={path.key} d={path.d} fill="#d8aa45" fillOpacity=".42" stroke="#155f52" strokeWidth="2" fillRule="evenodd"><title>{path.id}</title></path>)}</svg></div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Mini label="中心经度" value={summary.centroid[0].toFixed(5)}/><Mini label="中心纬度" value={summary.centroid[1].toFixed(5)}/><Mini label="面要素" value={`${summary.collection.features.length}个`}/><Mini label="估算面积" value={`${summary.areaKm2.toFixed(2)} km²`}/></div>
              <section className="mt-6 rounded-xl border border-[#9fb8b0] bg-[#eef6f2] p-5" aria-labelledby="gee-connect-title">
                <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-lg bg-[#17685a] text-white"><KeyRound className="size-5"/></span><div><p className="text-xs text-[#5d7770]">第2步</p><h3 id="gee-connect-title" className="text-lg font-semibold">连接Google Earth Engine</h3></div></div>{geeConnected && <span className="flex items-center gap-2 rounded-full bg-[#d8eee4] px-3 py-1.5 text-xs font-semibold text-[#17614f]"><ShieldCheck className="size-4"/>已连接</span>}</div>
                <div className="mt-4 rounded-lg border border-[#b8cec7] bg-white/70 p-4 text-sm leading-6 text-[#4f6962]"><strong className="text-[#17332f]">此按钮会进行真实Google授权，但必须先提供两项Google配置。</strong><br/>项目ID用于GEE计费与配额；OAuth网页客户端ID用于确认本站有权打开Google登录窗口。它们不是账号密码。</div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="text-sm font-medium">Google Cloud项目ID <span className="text-[#a33d2c]">*</span><input value={projectId} aria-invalid={connectAttempted && !projectId.trim()} onChange={(event) => { setProjectId(event.target.value); setGeeConnected(false); setGeeConnectMessage(''); }} placeholder="填写项目ID，不是项目名称" className={`mt-2 w-full rounded-md border bg-white px-3 py-2.5 text-sm ${connectAttempted && !projectId.trim() ? 'border-[#b94b3b] ring-2 ring-[#b94b3b]/15' : 'border-[#aebdb8]'}`}/><span className="mt-1.5 block text-xs font-normal text-[#667a74]">在Google Cloud顶部的项目选择器中查看。</span></label>
                  <label className="text-sm font-medium">OAuth网页客户端ID <span className="text-[#a33d2c]">*</span><input value={oauthClientId} aria-invalid={connectAttempted && !oauthClientId.trim()} onChange={(event) => { setOauthClientId(event.target.value); setGeeConnected(false); setGeeConnectMessage(''); }} placeholder="xxxx.apps.googleusercontent.com" className={`mt-2 w-full rounded-md border bg-white px-3 py-2.5 text-sm ${connectAttempted && !oauthClientId.trim() ? 'border-[#b94b3b] ring-2 ring-[#b94b3b]/15' : 'border-[#aebdb8]'}`}/><span className="mt-1.5 block text-xs font-normal text-[#667a74]">应用类型必须选择“Web应用”。</span></label>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3"><button onClick={connectGee} disabled={geeBusy !== ''} className="flex items-center gap-2 rounded-md bg-[#17685a] px-4 py-2.5 text-sm font-semibold text-white shadow-sm disabled:cursor-wait disabled:opacity-60">{geeBusy === 'connect' ? <LoaderCircle className="size-4 animate-spin"/> : <Satellite className="size-4"/>}{geeBusy === 'connect' ? '等待Google授权…' : geeConnected ? '重新授权并连接' : '授权并连接GEE'}</button><a className="text-xs font-medium text-[#28675c] underline underline-offset-4" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">创建OAuth客户端ID</a><a className="text-xs font-medium text-[#28675c] underline underline-offset-4" href="https://console.cloud.google.com/apis/library/earthengine.googleapis.com" target="_blank" rel="noreferrer">启用Earth Engine API</a></div>
                <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md bg-[#dfeae6] px-3 py-2.5 text-xs leading-5 text-[#4e6861]"><span>授权的JavaScript来源：</span><code className="break-all font-mono text-[#194f45]">{PUBLIC_SITE_ORIGIN}</code><button type="button" onClick={copySiteOrigin} className="ml-auto flex shrink-0 items-center gap-1 rounded border border-[#8daaa1] bg-white px-2 py-1 font-medium text-[#205f52]"><Copy className="size-3.5"/>复制</button></div>
                <p className="mt-3 text-xs leading-5 text-[#657973]">连接时浏览器应弹出Google账号授权窗口。访问令牌只保存在当前会话，不会上传到本站服务器。</p>
                {geeConnectMessage && <output className={`mt-4 block rounded-md border px-3 py-2.5 text-sm leading-6 ${geeConnected ? 'border-[#9fc8b8] bg-[#dceee7] text-[#1c5e50]' : 'border-[#dfaa9f] bg-[#f8dfd8] text-[#803426]'}`}>{geeConnectMessage}</output>}
              </section>

              <section className={`mt-5 rounded-xl border p-5 ${geeConnected ? 'border-[#c2b06f] bg-[#fffaf0]' : 'border-[#d2d0c7] bg-[#f6f5f1] opacity-70'}`} aria-labelledby="gee-analysis-title">
                <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-lg bg-[#d9aa45] text-[#17332f]"><Cloudy className="size-5"/></span><div><p className="text-xs text-[#756c50]">第3步</p><h3 id="gee-analysis-title" className="text-lg font-semibold">读取研究区遥感结果</h3></div></div>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <label className="text-sm font-medium">开始日期<input type="date" value={start} onChange={(event) => setStart(event.target.value)} className="mt-2 w-full rounded-md border bg-white px-3 py-2.5 text-sm"/></label>
                  <label className="text-sm font-medium">结束日期<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} className="mt-2 w-full rounded-md border bg-white px-3 py-2.5 text-sm"/></label>
                  <label className="text-sm font-medium">显示内容<select value={geeIndex} onChange={(event) => setGeeIndex(event.target.value as GeeIndex)} className="mt-2 w-full rounded-md border bg-white px-3 py-2.5 text-sm"><option value="RGB">Sentinel-2真彩色</option><option value="NDVI">NDVI植被活力</option><option value="NDMI">NDMI冠层含水</option><option value="MNDWI">MNDWI开放水体</option></select></label>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3"><button onClick={runGeeAnalysis} disabled={!geeConnected || geeBusy !== '' || !start || !end || start >= end} className="flex items-center gap-2 rounded-md bg-[#9f7017] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{geeBusy === 'analyse' ? <LoaderCircle className="size-4 animate-spin"/> : <Play className="size-4"/>}开始真实分析</button><button onClick={downloadGeeScript} disabled={busy || !start || !end || start >= end} className="flex items-center gap-2 rounded-md border border-[#aa9d77] px-4 py-2.5 text-sm font-semibold text-[#63542d] disabled:opacity-50"><CloudDownload className="size-4"/>下载完整GEE脚本</button></div>
                {geeAnalysisMessage && <output className={`mt-4 block rounded-md px-3 py-2.5 text-sm leading-6 ${geeAnalysisMessage.includes('失败') || geeAnalysisMessage.includes('请') || geeAnalysisMessage.includes('没有') || geeAnalysisMessage.includes('不匹配') ? 'bg-[#f8dfd8] text-[#803426]' : 'bg-[#dceee7] text-[#1c5e50]'}`}>{geeAnalysisMessage}</output>}
              </section>

              {geeResult && <section className="mt-5 overflow-hidden rounded-xl border border-[#b8b2a4] bg-white" aria-label="GEE分析结果">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d8d4ca] px-5 py-4"><div><p className="text-xs text-[#687873]">真实GEE计算结果</p><h3 className="mt-1 text-lg font-semibold">{geeResult.index === 'RGB' ? 'Sentinel-2真彩色影像' : `${geeResult.index}区域合成影像`}</h3></div><div className="flex gap-5 text-right text-xs text-[#687873]"><span>可用影像<strong className="mt-1 block font-mono text-base text-[#17332f]">{geeResult.sceneCount}景</strong></span>{geeResult.mean !== null && <span>区域均值<strong className="mt-1 block font-mono text-base text-[#17332f]">{geeResult.mean.toFixed(3)}</strong></span>}</div></div>
                <div className="bg-[#dfe7e3] p-3"><Image src={geeResult.imageUrl} alt={`${geeResult.index}研究区遥感分析结果`} width={1000} height={700} unoptimized className="mx-auto h-auto max-h-[640px] w-full object-contain"/></div>
                <p className="px-5 py-3 text-xs text-[#6a7874]">生成于 {geeResult.generatedAt} · 数据源：COPERNICUS/S2_SR_HARMONIZED · 场景云量&lt;60%</p>
              </section>}
            </div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return <div className="border-l-2 border-[#d6a640] bg-[#f0ede4] px-4 py-3"><span className="text-xs text-[#6d7975]">{label}</span><strong className="mt-1 block font-mono text-lg">{value}</strong></div>;
}
