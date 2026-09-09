'use client';

import { ChangeEvent, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CloudDownload,
  FileArchive,
  FileJson,
  LoaderCircle,
  MapPinned,
  Play,
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

const MAX_FILE_BYTES = 25 * 1024 * 1024;

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
  const [periodDays, setPeriodDays] = useState(7);
  const paths = useMemo(() => summary ? geometryPaths(summary) : [], [summary]);

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
    } catch (cause) {
      setSummary(null);
      setError(cause instanceof Error ? cause.message : '边界读取失败。');
    } finally {
      setBusy(false);
      event.target.value = '';
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
    <section id="custom-area" className="bg-[#edf0e9] py-16 lg:py-20">
      <div className="mx-auto max-w-7xl px-5 lg:px-8">
        <div className="grid gap-5 lg:grid-cols-[1fr_.78fr] lg:items-end">
          <div><div className="mb-3 flex items-center gap-2 text-xs font-medium tracking-[.16em] text-[#9b6a12]"><span className="h-px w-8 bg-current"/>01 / 通用研究区</div><h2 className="max-w-3xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">导入你自己的面状研究区</h2></div>
          <p className="max-w-xl text-sm leading-7 text-[#5c6b67]">支持GeoJSON，或包含.shp、.shx、.dbf、.prj的ZIP压缩包。边界在浏览器本地解析，系统会生成带有你研究区坐标的GEE脚本。</p>
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
            {error && <p role="alert" className="mt-4 flex gap-2 rounded-md bg-[#7a2f25]/40 p-3 text-xs leading-5 text-[#ffd5cc]"><AlertCircle className="mt-0.5 size-4 shrink-0"/>{error}</p>}
            {summary && <div className="mt-5 border-t border-white/10 pt-5"><p className="flex items-center gap-2 text-sm text-[#aee0ca]"><CheckCircle2 className="size-4"/>边界读取成功</p><dl className="mt-3 space-y-2 text-xs"><div className="flex justify-between gap-3"><dt className="text-[#9ebbb4]">文件</dt><dd className="max-w-48 truncate">{summary.fileName}</dd></div><div className="flex justify-between"><dt className="text-[#9ebbb4]">面要素</dt><dd>{summary.collection.features.length}个</dd></div><div className="flex justify-between"><dt className="text-[#9ebbb4]">估算面积</dt><dd>{summary.areaKm2.toFixed(2)} km²</dd></div><div className="flex justify-between"><dt className="text-[#9ebbb4]">建议投影</dt><dd>{summary.crs}</dd></div></dl></div>}
          </aside>

          <div className="min-w-0 p-6 lg:p-8">
            {!summary ? <div className="grid min-h-[510px] place-items-center rounded-lg border border-dashed border-[#b7b1a4] bg-[#f7f6f1] text-center"><div className="max-w-md px-6"><MapPinned className="mx-auto size-10 text-[#73928a]"/><h3 className="mt-5 text-xl font-semibold">等待研究区文件</h3><p className="mt-3 text-sm leading-7 text-[#687873]">上传后将在这里预览面边界、检查WGS84坐标范围，并为每个面生成唯一分析ID。</p></div></div> : <div>
              <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs text-[#687873]">自定义研究区已就绪</p><h3 className="mt-1 text-2xl font-semibold">边界预览与GEE任务配置</h3></div><button className="flex items-center gap-2 rounded-md border border-[#8eb8ab] px-3 py-2 text-sm font-medium text-[#205f52]" onClick={() => downloadText('shuimai_custom_area.geojson', JSON.stringify(summary.collection, null, 2), 'application/geo+json')}><FileJson className="size-4"/>下载标准化GeoJSON</button></div>
              <div className="mt-5 overflow-hidden rounded-lg border border-[#c8c4b8] bg-[#e8eee9]"><svg viewBox="0 0 800 450" className="h-auto max-h-[390px] w-full" aria-label="用户上传研究区边界预览"><title>用户上传研究区边界预览</title><defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#b9c9c2" strokeWidth="1"/></pattern></defs><rect width="800" height="450" fill="url(#grid)"/>{paths.map((path) => <path key={path.key} d={path.d} fill="#d8aa45" fillOpacity=".42" stroke="#155f52" strokeWidth="2" fillRule="evenodd"><title>{path.id}</title></path>)}</svg></div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Mini label="中心经度" value={summary.centroid[0].toFixed(5)}/><Mini label="中心纬度" value={summary.centroid[1].toFixed(5)}/><Mini label="面要素" value={`${summary.collection.features.length}个`}/><Mini label="估算面积" value={`${summary.areaKm2.toFixed(2)} km²`}/></div>
              <div className="mt-5 rounded-lg border border-[#cbc7b8] bg-[#f6f4ed] p-4"><div className="grid gap-4 sm:grid-cols-3"><label className="text-sm font-medium">开始日期<input type="date" value={start} onChange={(event) => setStart(event.target.value)} className="mt-2 w-full rounded-md border bg-white px-3 py-2 text-sm"/></label><label className="text-sm font-medium">结束日期<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} className="mt-2 w-full rounded-md border bg-white px-3 py-2 text-sm"/></label><label className="text-sm font-medium">观测窗口<select value={periodDays} onChange={(event) => setPeriodDays(Number(event.target.value))} className="mt-2 w-full rounded-md border bg-white px-3 py-2 text-sm"><option value={7}>7天</option><option value={14}>14天</option><option value={30}>30天</option></select></label></div>
                <div className="mt-4 flex flex-wrap items-center gap-3"><button onClick={downloadGeeScript} disabled={busy || !start || !end || start >= end} className="flex items-center gap-2 rounded-md bg-[#17685a] px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"><CloudDownload className="size-4"/>生成此区域GEE脚本</button><a href="https://code.earthengine.google.com/" target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md border border-[#9eb7b0] px-4 py-3 text-sm font-semibold text-[#285f54]"><Play className="size-4"/>打开GEE运行</a><span className="text-xs text-[#687873]">首次运行仍需人工确认边界后，将BOUNDARIES_CONFIRMED改为true。</span></div>
              </div>
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
