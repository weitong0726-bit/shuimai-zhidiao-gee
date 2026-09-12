'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import {
  AlertCircle,
  Activity,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  CloudDownload,
  Cloudy,
  FileArchive,
  FileJson,
  LoaderCircle,
  MapPinned,
  Play,
  RefreshCw,
  Satellite,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react';
import {
  WaterDecisionPanel,
  type DecisionPlan,
  type GeeEvidence,
  type GeeUnitMetric,
} from './water-decision-panel';
import {
  EvidenceContextPanel,
  type ContextEvidence,
} from './evidence-context-panel';
import {
  ScreeningScenarioPanel,
  type ScreeningScenario,
} from './screening-scenario-panel';

type Position = [number, number];
type PolygonCoordinates = Position[][];
type MultiPolygonCoordinates = PolygonCoordinates[];
type PolygonGeometry = { type: 'Polygon'; coordinates: PolygonCoordinates };
type MultiPolygonGeometry = {
  type: 'MultiPolygon';
  coordinates: MultiPolygonCoordinates;
};
type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;
type AreaFeature = {
  type: 'Feature';
  properties: Record<string, unknown> & { id: string };
  geometry: AreaGeometry;
};
type AreaCollection = { type: 'FeatureCollection'; features: AreaFeature[] };
type RawFeature = {
  type?: string;
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
};
type RawCollection = {
  type?: string;
  features?: RawFeature[];
  fileName?: string;
};

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
  start: string;
  end: string;
  unitMetrics: GeeUnitMetric[];
  projectId?: string;
  dataSource?: string;
  scaleM?: number;
  qualityNote?: string;
  context?: ContextEvidence;
};

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function geeErrorMessage(cause: unknown) {
  let message = '未知错误';
  if (cause instanceof Error) message = cause.message;
  else if (typeof cause === 'string') message = cause;
  else if (
    cause &&
    typeof cause === 'object' &&
    'message' in cause &&
    typeof cause.message === 'string'
  )
    message = cause.message;
  if (/403|permission|not registered|not authorized/i.test(message))
    return '网站的GEE服务账号权限不足，请联系管理员检查Earth Engine角色和项目注册状态。';
  if (/429|quota/i.test(message))
    return 'GEE请求额度暂时不足，请稍后再试或更换有额度的Cloud项目。';
  return `GEE请求失败：${message}`;
}

function collectPositions(value: unknown, output: Position[]) {
  if (!Array.isArray(value)) return;
  if (
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  ) {
    output.push([value[0], value[1]]);
    return;
  }
  value.forEach((item) => collectPositions(item, output));
}

function twoDimensionalCoordinates(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  ) {
    return [value[0], value[1]] satisfies Position;
  }
  return value.map(twoDimensionalCoordinates);
}

function ringAreaKm2(ring: Position[], latitude: number) {
  if (ring.length < 3) return 0;
  const xScale = 111.32 * Math.cos((latitude * Math.PI) / 180);
  const yScale = 110.574;
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    sum +=
      current[0] * xScale * next[1] * yScale -
      next[0] * xScale * current[1] * yScale;
  }
  return Math.abs(sum) / 2;
}

function geometryAreaKm2(geometry: AreaGeometry, latitude: number) {
  const polygons =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((total, polygon) => {
    if (!polygon.length) return total;
    const outer = ringAreaKm2(polygon[0], latitude);
    const holes = polygon
      .slice(1)
      .reduce((sum, ring) => sum + ringAreaKm2(ring, latitude), 0);
    return total + Math.max(0, outer - holes);
  }, 0);
}

function normalizeCollection(raw: unknown, fileName: string): AreaSummary {
  const candidates = Array.isArray(raw) ? raw : [raw];
  const rawFeatures = candidates.flatMap((item) => {
    const collection = item as RawCollection;
    return collection?.type === 'FeatureCollection' &&
      Array.isArray(collection.features)
      ? collection.features
      : [];
  });
  const usedIds = new Set<string>();
  const features: AreaFeature[] = [];
  rawFeatures.forEach((feature, index) => {
    if (
      !feature.geometry ||
      (feature.geometry.type !== 'Polygon' &&
        feature.geometry.type !== 'MultiPolygon')
    )
      return;
    const geometry = {
      type: feature.geometry.type,
      coordinates: twoDimensionalCoordinates(feature.geometry.coordinates),
    } as AreaGeometry;
    const positions: Position[] = [];
    collectPositions(geometry.coordinates, positions);
    if (
      positions.length < 4 ||
      positions.some(
        ([lon, lat]) => !Number.isFinite(lon) || !Number.isFinite(lat),
      )
    )
      return;
    const properties = { ...feature.properties };
    const rawId =
      properties.id ??
      properties.ID ??
      properties.AdminCode ??
      properties.BIANMA ??
      properties.name ??
      properties.Name ??
      properties.NAME;
    const requestedId =
      (typeof rawId === 'string' || typeof rawId === 'number'
        ? String(rawId).trim()
        : '') || `U${index + 1}`;
    let id =
      requestedId.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) ||
      `U${index + 1}`;
    while (usedIds.has(id)) id = `${id}_${index + 1}`;
    usedIds.add(id);
    const rawName =
      properties.name ??
      properties.Name ??
      properties.NAME ??
      properties.PYNAME ??
      id;
    const name =
      typeof rawName === 'string' || typeof rawName === 'number'
        ? String(rawName)
        : id;
    features.push({
      type: 'Feature',
      properties: { ...properties, id, name },
      geometry,
    });
  });
  if (!features.length)
    throw new Error(
      '没有识别到Polygon或MultiPolygon面要素。请上传面状研究区，而不是点或线。',
    );
  if (features.length > 150)
    throw new Error('面要素超过150个。请先合并或筛选研究区，避免GEE任务过大。');
  const positions: Position[] = [];
  features.forEach((feature) =>
    collectPositions(feature.geometry.coordinates, positions),
  );
  const minLon = Math.min(...positions.map((point) => point[0]));
  const maxLon = Math.max(...positions.map((point) => point[0]));
  const minLat = Math.min(...positions.map((point) => point[1]));
  const maxLat = Math.max(...positions.map((point) => point[1]));
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw new Error(
      '坐标不是WGS84经纬度。Shapefile压缩包中必须包含正确的.prj文件。',
    );
  }
  const centroid: Position = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const areaKm2 = features.reduce(
    (sum, feature) => sum + geometryAreaKm2(feature.geometry, centroid[1]),
    0,
  );
  const zone = Math.max(
    1,
    Math.min(60, Math.floor((centroid[0] + 180) / 6) + 1),
  );
  const crs = `EPSG:${centroid[1] >= 0 ? 32600 + zone : 32700 + zone}`;
  return {
    fileName,
    collection: { type: 'FeatureCollection', features },
    bbox: [minLon, minLat, maxLon, maxLat],
    areaKm2,
    centroid,
    crs,
  };
}

function geometryPaths(summary: AreaSummary) {
  const [minLon, minLat, maxLon, maxLat] = summary.bbox;
  const width = Math.max(maxLon - minLon, 0.000001);
  const height = Math.max(maxLat - minLat, 0.000001);
  const scale = Math.min(720 / width, 390 / height);
  const offsetX = (800 - width * scale) / 2;
  const offsetY = (450 - height * scale) / 2;
  const point = ([lon, lat]: Position) =>
    `${offsetX + (lon - minLon) * scale},${450 - offsetY - (lat - minLat) * scale}`;
  return summary.collection.features.flatMap((feature, featureIndex) => {
    const polygons =
      feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    return polygons.map((polygon, polygonIndex) => ({
      key: `${featureIndex}-${polygonIndex}`,
      id: feature.properties.id,
      d: polygon
        .map(
          (ring) =>
            `${ring.map((position, index) => `${index ? 'L' : 'M'}${point(position)}`).join(' ')} Z`,
        )
        .join(' '),
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

async function makeGeeScript(
  summary: AreaSummary,
  start: string,
  end: string,
  periodDays: number,
) {
  const response = await fetch('/gee-wetland-observations.js');
  if (!response.ok) throw new Error('无法读取GEE脚本模板。');
  let script = await response.text();
  const unitsCode = `var units = ee.FeatureCollection(${JSON.stringify(summary.collection)});`;
  const span = Math.max(
    summary.bbox[2] - summary.bbox[0],
    summary.bbox[3] - summary.bbox[1],
  );
  const analysisScale =
    span <= 1 ? 20 : span <= 3 ? 100 : span <= 8 ? 250 : 500;
  script = script.replace(
    /\/\/ BEGIN_ANALYSIS_UNITS[\s\S]*?\/\/ END_ANALYSIS_UNITS/,
    `// 用户导入的WGS84面状分析单元；网站已标准化二维坐标并补充唯一id。\n${unitsCode}\n// 首次运行仍需核查边界现势性以及它是否代表真实滩区或管理单元。`,
  );
  script = script.replace(
    "var START = '2025-06-01';",
    `var START = '${start}';`,
  );
  script = script.replace("var END = '2025-07-01';", `var END = '${end}';`);
  script = script.replace(
    'var PERIOD_DAYS = 7;',
    `var PERIOD_DAYS = ${periodDays};`,
  );
  script = script.replace('var SCALE = 20;', `var SCALE = ${analysisScale};`);
  script = script.replace(
    "var CRS = 'EPSG:32649';",
    `var CRS = '${summary.crs}';`,
  );
  script = script
    .replace(/maxPixels:1e7/g, 'maxPixels:1e9')
    .replace('maxPixels:1e8', 'maxPixels:1e13');
  script = script
    .replace(/H1\/H2/g, '用户研究单元')
    .replace(/H1和H2/g, '用户研究单元');
  return script;
}

export function CustomAreaWorkspace() {
  const [summary, setSummary] = useState<AreaSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState('2025-06-01');
  const [end, setEnd] = useState('2025-07-01');
  const periodDays = 7;
  const [geeIndex, setGeeIndex] = useState<GeeIndex>('NDMI');
  const [geeServer, setGeeServer] = useState<
    'checking' | 'ready' | 'unavailable'
  >('checking');
  const [geeServerDetail, setGeeServerDetail] = useState(
    '正在验证Earth Engine授权与Cloud项目…',
  );
  const [geeBusy, setGeeBusy] = useState(false);
  const [geeAnalysisMessage, setGeeAnalysisMessage] = useState('');
  const [geeResult, setGeeResult] = useState<GeeResult | null>(null);
  const [baselineResult, setBaselineResult] = useState<GeeResult | null>(null);
  const [decisionPlan, setDecisionPlan] = useState<DecisionPlan | null>(null);
  const [screeningScenario, setScreeningScenario] =
    useState<ScreeningScenario | null>(null);
  const paths = useMemo(
    () => (summary ? geometryPaths(summary) : []),
    [summary],
  );

  useEffect(() => {
    let active = true;
    fetch('/api/gee')
      .then(async (response) => {
        const payload = (await response.json()) as {
          projectId?: string;
          authMode?: string;
          error?: string;
        };
        if (!active) return;
        setGeeServer(response.ok ? 'ready' : 'unavailable');
        setGeeServerDetail(
          response.ok
            ? `Cloud项目 ${payload.projectId || '已授权'} · ${payload.authMode === 'local_user' ? '本机研究者账号' : '站点服务账号'}`
            : payload.error || '无法连接Earth Engine，请检查本地桥接服务。',
        );
      })
      .catch(() => {
        if (active) {
          setGeeServer('unavailable');
          setGeeServerDetail('网站无法访问本地GEE桥接服务。');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function importBoundary(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      if (file.size > MAX_FILE_BYTES)
        throw new Error('文件超过25MB，请先简化边界或减少要素。');
      let parsed: unknown;
      if (file.name.toLowerCase().endsWith('.zip')) {
        const shp = (await import('shpjs')).default;
        parsed = await shp(await file.arrayBuffer());
      } else {
        parsed = JSON.parse(await file.text());
      }
      setSummary(normalizeCollection(parsed, file.name));
      setGeeResult(null);
      setBaselineResult(null);
      setScreeningScenario(null);
    } catch (cause) {
      setSummary(null);
      setError(cause instanceof Error ? cause.message : '边界读取失败。');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  async function loadDemoArea() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/wetland-data/demo_area.geojson');
      if (!response.ok) throw new Error('演示研究区读取失败。');
      setSummary(
        normalizeCollection(await response.json(), '惠济湿地演示区.geojson'),
      );
      setGeeResult(null);
      setBaselineResult(null);
      setScreeningScenario(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '演示研究区读取失败。');
    } finally {
      setBusy(false);
    }
  }

  async function loadYellowRiverArea() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        '/wetland-data/yellow_river_counties.geojson',
      );
      if (!response.ok) throw new Error('黄河滩区涉及县域边界读取失败。');
      setSummary(
        normalizeCollection(
          await response.json(),
          '黄河滩区中下游涉及县域（用户资料）.geojson',
        ),
      );
      setGeeResult(null);
      setBaselineResult(null);
      setScreeningScenario(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : '黄河滩区涉及县域边界读取失败。',
      );
    } finally {
      setBusy(false);
    }
  }

  async function runGeeAnalysis() {
    if (!summary) {
      setGeeAnalysisMessage('请先导入研究区边界。');
      return;
    }
    if (geeServer !== 'ready') {
      setGeeAnalysisMessage('GEE云端服务暂不可用，请稍后刷新页面。');
      return;
    }
    if (!start || !end || start >= end) {
      setGeeAnalysisMessage('结束日期必须晚于开始日期。');
      return;
    }
    setGeeBusy(true);
    setGeeAnalysisMessage('正在检索Sentinel-2并计算区域结果…');
    try {
      const response = await fetch('/api/gee', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          boundary: summary.collection,
          start,
          end,
          index: geeIndex,
        }),
      });
      const payload = (await response.json()) as Partial<GeeResult> & {
        error?: string;
      };
      if (
        !response.ok ||
        !payload.imageUrl ||
        !payload.index ||
        typeof payload.sceneCount !== 'number'
      ) {
        throw new Error(payload.error || '服务器没有返回有效的GEE结果。');
      }
      const result: GeeResult = {
        imageUrl: payload.imageUrl,
        index: payload.index,
        sceneCount: payload.sceneCount,
        mean: typeof payload.mean === 'number' ? payload.mean : null,
        generatedAt: payload.generatedAt
          ? new Date(payload.generatedAt).toLocaleString('zh-CN')
          : new Date().toLocaleString('zh-CN'),
        start,
        end,
        unitMetrics: Array.isArray(payload.unitMetrics)
          ? payload.unitMetrics
          : [],
        projectId: payload.projectId,
        dataSource: payload.dataSource,
        scaleM: payload.scaleM,
        qualityNote: payload.qualityNote,
        context: payload.context,
      };
      setGeeResult(result);
      setGeeAnalysisMessage(
        `分析完成：共使用${result.sceneCount}景Sentinel-2影像。`,
      );
    } catch (cause) {
      setGeeAnalysisMessage(geeErrorMessage(cause));
    } finally {
      setGeeBusy(false);
    }
  }

  function exportClosureSummary() {
    if (!summary || !geeResult) return;
    const artifact = {
      exportedAt: new Date().toISOString(),
      project: '水脉智调｜湿地生态补水优先区识别与情景推演',
      boundary: {
        fileName: summary.fileName,
        unitCount: summary.collection.features.length,
        areaKm2: summary.areaKm2,
        centroid: summary.centroid,
        crs: summary.crs,
      },
      observation: geeResult,
      screeningScenario,
      decision: decisionPlan,
      baseline: baselineResult,
      verification: {
        recommendedWindow: '同物候期历史回测；具备实施记录后再做补水后复测',
        fieldChecks: [
          '边界现势性与候选湿地空间范围',
          '样点水位与土壤含水率',
          '同期降雨、黄河来水与人为扰动',
          '未来若实施补水，再补充水源、通道与实际水量',
        ],
      },
      assumptions: [
        '候选湿地由JRC历史水面与Dynamic World当期水体/淹水植被概率识别',
        '潜在可达性由MERIT Hydro HAND与JRC历史水面组合，不代表实际渠道连通',
        '2/5/10 mm为等效水深情景，不代表已批准或可调配水量',
        '单元情景等效水深上限为当前情景平均水深的2倍',
        '县域边界仅用于初筛，不等同于精确滩区或湿地管理单元',
      ],
    };
    downloadText(
      'shuimai_decision_closure.json',
      JSON.stringify(artifact, null, 2),
      'application/json;charset=utf-8',
    );
  }

  const evidence: GeeEvidence | null = geeResult
    ? {
        start: geeResult.start,
        end: geeResult.end,
        sceneCount: geeResult.sceneCount,
        mean: geeResult.mean,
        unitMetrics: geeResult.unitMetrics,
        projectId: geeResult.projectId,
      }
    : null;
  const hasFollowUp = Boolean(
    baselineResult &&
    geeResult &&
    (baselineResult.start !== geeResult.start ||
      baselineResult.end !== geeResult.end),
  );
  const comparableDelta =
    baselineResult &&
    geeResult &&
    (baselineResult.start !== geeResult.start ||
      baselineResult.end !== geeResult.end) &&
    baselineResult.index === geeResult.index &&
    baselineResult.mean !== null &&
    geeResult.mean !== null
      ? geeResult.mean - baselineResult.mean
      : null;
  const followUpMessage =
    baselineResult &&
    geeResult &&
    (baselineResult.start !== geeResult.start ||
      baselineResult.end !== geeResult.end)
      ? comparableDelta === null
        ? '本期与基线指标不同，保留影像证据但不直接比较数值。'
        : comparableDelta > 0
          ? `${geeResult.index}较基线提高${comparableDelta.toFixed(3)}，仅表示后期水分或植被状态更高；需结合同期降雨、来水与物候，不能直接归因于补水。`
          : `${geeResult.index}较基线未提高，仅表示后期遥感状态未改善；需结合同期降雨、来水、物候和数据覆盖解释。`
      : '';

  async function downloadGeeScript() {
    if (!summary) return;
    setBusy(true);
    setError('');
    try {
      const script = await makeGeeScript(summary, start, end, periodDays);
      downloadText(
        'shuimai_custom_area_gee.js',
        script,
        'text/javascript;charset=utf-8',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '脚本生成失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="custom-area" className="min-h-screen py-8 lg:py-12">
      <div className="mx-auto max-w-7xl px-5 lg:px-8">
        <header className="mb-9 flex flex-wrap items-center justify-between gap-4 border-b border-[#c8c4b8] pb-5">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-[#d9aa45] text-[#17332f]">
              <MapPinned className="size-5" />
            </span>
            <div>
              <strong className="block text-base tracking-[.16em] text-[#173d38]">
                水脉智调
              </strong>
              <span className="mt-1 block text-xs text-[#65766f]">
                湿地生态补水优先区筛查
              </span>
            </div>
          </div>
          <span
            className={`status-pill ${geeServer === 'ready' ? 'safe' : geeServer === 'checking' ? 'warning' : 'danger'}`}
          >
            {geeServer === 'ready' ? (
              <CheckCircle2 className="size-3.5" />
            ) : geeServer === 'checking' ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <AlertCircle className="size-3.5" />
            )}
            {geeServer === 'ready'
              ? 'GEE真实服务已连接'
              : geeServer === 'checking'
                ? '验证GEE连接'
                : 'GEE连接需检查'}
          </span>
        </header>
        <div className="grid gap-5 lg:grid-cols-[1fr_.78fr] lg:items-end">
          <div>
            <div className="eyebrow">
              <span />
              DECISION WORKSPACE
            </div>
            <h1 className="max-w-3xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
              从湿地候选区识别，到可复核的补水情景优先级
            </h1>
          </div>
          <p className="max-w-xl text-sm leading-7 text-[#5c6b67]">
            以公开遥感与水文地形数据识别候选湿地、诊断水分压力，并在不同等效水深情景下形成县域优先级；结果用于前期筛查，不冒充工程调度。
          </p>
        </div>
        <div className="workflow-strip mt-8">
          <WorkflowStep
            index="01"
            title="界定单元"
            detail="行政或自定义分析单元"
            state={summary ? 'done' : 'active'}
          />
          <WorkflowStep
            index="02"
            title="遥感诊断"
            detail="S2 + JRC + DW"
            state={!summary ? 'idle' : geeResult ? 'done' : 'active'}
          />
          <WorkflowStep
            index="03"
            title="背景证据"
            detail="气候与近5年异常"
            state={geeResult?.context ? 'done' : 'idle'}
          />
          <WorkflowStep
            index="04"
            title="潜在可达性"
            detail="HAND + 历史水面"
            state={geeResult ? 'done' : 'idle'}
          />
          <WorkflowStep
            index="05"
            title="情景优先级"
            detail="2 / 5 / 10 mm情景"
            state={geeResult ? (decisionPlan ? 'done' : 'active') : 'idle'}
          />
          <WorkflowStep
            index="06"
            title="历史回测"
            detail="同物候期对照"
            state={baselineResult ? 'active' : 'idle'}
          />
        </div>
        <div className="mt-8 grid overflow-hidden rounded-xl border border-[#bdb7a9] bg-[#fffef9] shadow-sm lg:grid-cols-[360px_1fr]">
          <aside className="bg-[#123d38] p-6 text-white">
            <div className="flex items-center gap-3">
              <FileArchive className="size-6 text-[#e0b957]" />
              <div>
                <p className="text-xs text-[#a9c5be]">BOUNDARY INTAKE</p>
                <h3 className="mt-1 text-xl font-semibold">上传研究区边界</h3>
              </div>
            </div>
            <div className="mt-6 rounded-lg border border-white/15 bg-white/5 p-4 text-sm leading-6 text-[#d2e1dd]">
              <b className="text-white">Shapefile请先压缩为ZIP</b>
              <br />
              同名的.shp、.shx、.dbf、.prj放在压缩包根目录；缺少.prj可能导致坐标无法转换。
            </div>
            <label className="mt-5 flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-[#d9aa45] px-4 py-3 text-sm font-semibold text-[#17332f] hover:bg-[#e5ba5c]">
              {busy ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <UploadCloud className="size-4" />
              )}
              选择ZIP或GeoJSON
              <input
                className="sr-only"
                type="file"
                accept=".zip,.geojson,.json,application/zip,application/geo+json,application/json"
                onChange={importBoundary}
              />
            </label>
            <button
              type="button"
              onClick={loadYellowRiverArea}
              disabled={busy}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-[#e0b957] px-4 py-2.5 text-sm font-semibold text-[#f1d485] hover:bg-white/10 disabled:opacity-50"
            >
              <MapPinned className="size-4" />
              加载黄河滩区涉及县域
            </button>
            <button
              type="button"
              onClick={loadDemoArea}
              disabled={busy}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-white/25 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-50"
            >
              <RefreshCw className="size-4" />
              加载惠济湿地演示区
            </button>
            <p className="mt-3 text-xs leading-5 text-[#9ebbb4]">
              最多25MB、150个面要素。点和线文件不会进入分析。
            </p>
            <ol className="mt-6 space-y-3 border-t border-white/10 pt-5 text-xs leading-5 text-[#c7dad5]">
              <li className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full border border-[#d9aa45] text-[#edc86f]">
                  1
                </span>
                <span>上传并确认研究区边界</span>
              </li>
              <li className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full border border-white/25">
                  2
                </span>
                <span>选择指标并读取GEE影像</span>
              </li>
              <li className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full border border-white/25">
                  3
                </span>
                <span>生成情景优先级并开展历史回测</span>
              </li>
            </ol>
            {error && (
              <p
                role="alert"
                className="mt-4 flex gap-2 rounded-md bg-[#7a2f25]/40 p-3 text-xs leading-5 text-[#ffd5cc]"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            )}
            {summary && (
              <div className="mt-5 border-t border-white/10 pt-5">
                <p className="flex items-center gap-2 text-sm text-[#aee0ca]">
                  <CheckCircle2 className="size-4" />
                  边界读取成功
                </p>
                <dl className="mt-3 space-y-2 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-[#9ebbb4]">文件</dt>
                    <dd className="max-w-48 truncate">{summary.fileName}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[#9ebbb4]">面要素</dt>
                    <dd>{summary.collection.features.length}个</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[#9ebbb4]">估算面积</dt>
                    <dd>{summary.areaKm2.toFixed(2)} km²</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[#9ebbb4]">建议投影</dt>
                    <dd>{summary.crs}</dd>
                  </div>
                </dl>
              </div>
            )}
          </aside>

          <div className="min-w-0 p-6 lg:p-8">
            {!summary ? (
              <div className="grid min-h-[510px] place-items-center rounded-lg border border-dashed border-[#b7b1a4] bg-[#f7f6f1] text-center">
                <div className="max-w-md px-6">
                  <MapPinned className="mx-auto size-10 text-[#73928a]" />
                  <h3 className="mt-5 text-xl font-semibold">等待研究区文件</h3>
                  <p className="mt-3 text-sm leading-7 text-[#687873]">
                    上传后将在这里预览面边界、检查WGS84坐标范围，并为每个面生成唯一分析ID。
                  </p>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs text-[#687873]">
                      第1步 · 自定义研究区已就绪
                    </p>
                    <h3 className="mt-1 text-2xl font-semibold">边界预览</h3>
                  </div>
                  <button
                    className="flex items-center gap-2 rounded-md border border-[#8eb8ab] px-3 py-2 text-sm font-medium text-[#205f52]"
                    onClick={() =>
                      downloadText(
                        'shuimai_custom_area.geojson',
                        JSON.stringify(summary.collection, null, 2),
                        'application/geo+json',
                      )
                    }
                  >
                    <FileJson className="size-4" />
                    下载标准化GeoJSON
                  </button>
                </div>
                <div className="mt-5 overflow-hidden rounded-lg border border-[#c8c4b8] bg-[#e8eee9]">
                  <svg
                    viewBox="0 0 800 450"
                    className="h-auto max-h-[390px] w-full"
                    aria-label="用户上传研究区边界预览"
                  >
                    <title>用户上传研究区边界预览</title>
                    <defs>
                      <pattern
                        id="grid"
                        width="40"
                        height="40"
                        patternUnits="userSpaceOnUse"
                      >
                        <path
                          d="M 40 0 L 0 0 0 40"
                          fill="none"
                          stroke="#b9c9c2"
                          strokeWidth="1"
                        />
                      </pattern>
                    </defs>
                    <rect width="800" height="450" fill="url(#grid)" />
                    {paths.map((path) => (
                      <path
                        key={path.key}
                        d={path.d}
                        fill="#d8aa45"
                        fillOpacity=".42"
                        stroke="#155f52"
                        strokeWidth="2"
                        fillRule="evenodd"
                      >
                        <title>{path.id}</title>
                      </path>
                    ))}
                  </svg>
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Mini
                    label="中心经度"
                    value={summary.centroid[0].toFixed(5)}
                  />
                  <Mini
                    label="中心纬度"
                    value={summary.centroid[1].toFixed(5)}
                  />
                  <Mini
                    label="面要素"
                    value={`${summary.collection.features.length}个`}
                  />
                  <Mini
                    label="估算面积"
                    value={`${summary.areaKm2.toFixed(2)} km²`}
                  />
                </div>
                <section
                  className="mt-6 rounded-xl border border-[#c2b06f] bg-[#fffaf0] p-5"
                  aria-labelledby="gee-analysis-title"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="grid size-10 place-items-center rounded-lg bg-[#d9aa45] text-[#17332f]">
                        <Cloudy className="size-5" />
                      </span>
                      <div>
                        <p className="text-xs text-[#756c50]">第2步</p>
                        <h3
                          id="gee-analysis-title"
                          className="text-lg font-semibold"
                        >
                          直接读取研究区遥感结果
                        </h3>
                      </div>
                    </div>
                    <span
                      className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${geeServer === 'ready' ? 'bg-[#d8eee4] text-[#17614f]' : geeServer === 'checking' ? 'bg-[#efe7d1] text-[#806222]' : 'bg-[#f4ddd8] text-[#8b382b]'}`}
                    >
                      {geeServer === 'checking' ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Satellite className="size-4" />
                      )}
                      {geeServer === 'ready'
                        ? 'GEE云端已就绪'
                        : geeServer === 'checking'
                          ? '正在检查GEE服务'
                          : 'GEE服务暂不可用'}
                    </span>
                  </div>
                  <p className="mt-4 rounded-lg border border-[#dbc991] bg-white/70 p-3 text-sm leading-6 text-[#655a38]">
                    <b>{geeServerDetail}</b>
                    <br />
                    当前使用本机已授权的研究者账号完成计算，凭据不进入浏览器与项目源码；正式部署时可切换为站点服务账号。
                  </p>
                  <div className="mt-4 grid gap-4 sm:grid-cols-3">
                    <label className="text-sm font-medium">
                      开始日期
                      <input
                        type="date"
                        value={start}
                        onChange={(event) => setStart(event.target.value)}
                        className="mt-2 w-full rounded-md border bg-white px-3 py-2.5 text-sm"
                      />
                    </label>
                    <label className="text-sm font-medium">
                      结束日期
                      <input
                        type="date"
                        value={end}
                        onChange={(event) => setEnd(event.target.value)}
                        className="mt-2 w-full rounded-md border bg-white px-3 py-2.5 text-sm"
                      />
                    </label>
                    <label className="text-sm font-medium">
                      显示内容
                      <select
                        value={geeIndex}
                        onChange={(event) =>
                          setGeeIndex(event.target.value as GeeIndex)
                        }
                        className="mt-2 w-full rounded-md border bg-white px-3 py-2.5 text-sm"
                      >
                        <option value="RGB">Sentinel-2真彩色</option>
                        <option value="NDVI">NDVI植被活力</option>
                        <option value="NDMI">NDMI冠层含水</option>
                        <option value="MNDWI">MNDWI开放水体</option>
                      </select>
                    </label>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <button
                      onClick={runGeeAnalysis}
                      disabled={
                        geeServer !== 'ready' ||
                        geeBusy ||
                        !start ||
                        !end ||
                        start >= end
                      }
                      className="action-primary"
                    >
                      {geeBusy ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Play className="size-4" />
                      )}
                      {geeBusy ? 'GEE正在计算…' : '开始真实分析'}
                    </button>
                    <button
                      onClick={downloadGeeScript}
                      disabled={busy || !start || !end || start >= end}
                      className="action-secondary"
                    >
                      <CloudDownload className="size-4" />
                      下载完整GEE脚本
                    </button>
                  </div>
                  {geeAnalysisMessage && (
                    <output
                      className={`mt-4 block rounded-md px-3 py-2.5 text-sm leading-6 ${geeAnalysisMessage.includes('失败') || geeAnalysisMessage.includes('请') || geeAnalysisMessage.includes('没有') || geeAnalysisMessage.includes('不匹配') ? 'bg-[#f8dfd8] text-[#803426]' : 'bg-[#dceee7] text-[#1c5e50]'}`}
                    >
                      {geeAnalysisMessage}
                    </output>
                  )}
                </section>

                {geeResult && (
                  <section
                    className="mt-5 overflow-hidden rounded-xl border border-[#b8b2a4] bg-white"
                    aria-label="GEE分析结果"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d8d4ca] px-5 py-4">
                      <div>
                        <p className="text-xs text-[#687873]">
                          真实GEE计算结果
                        </p>
                        <h3 className="mt-1 text-lg font-semibold">
                          {geeResult.index === 'RGB'
                            ? 'Sentinel-2真彩色影像'
                            : `${geeResult.index}区域合成影像`}
                        </h3>
                      </div>
                      <div className="flex gap-5 text-right text-xs text-[#687873]">
                        <span>
                          可用影像
                          <strong className="mt-1 block font-mono text-base text-[#17332f]">
                            {geeResult.sceneCount}景
                          </strong>
                        </span>
                        {geeResult.mean !== null && (
                          <span>
                            区域均值
                            <strong className="mt-1 block font-mono text-base text-[#17332f]">
                              {geeResult.mean.toFixed(3)}
                            </strong>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="bg-[#dfe7e3] p-3">
                      <Image
                        src={geeResult.imageUrl}
                        alt={`${geeResult.index}研究区遥感分析结果`}
                        width={1000}
                        height={700}
                        unoptimized
                        className="mx-auto h-auto max-h-[640px] w-full object-contain"
                      />
                    </div>
                    {geeResult.unitMetrics.length > 0 && (
                      <div className="overflow-x-auto border-t border-[#d8d4ca]">
                        <table className="w-full min-w-[720px] text-sm">
                          <thead>
                            <tr className="bg-[#f4f7f5] text-left text-xs text-[#667773]">
                              <th className="px-5 py-3">分析单元</th>
                              <th className="px-4 py-3">有效覆盖</th>
                              <th className="px-4 py-3">NDVI</th>
                              <th className="px-4 py-3">NDMI</th>
                              <th className="px-4 py-3">候选湿地</th>
                              <th className="px-5 py-3">潜在可达性</th>
                            </tr>
                          </thead>
                          <tbody>
                            {geeResult.unitMetrics.map((unit) => (
                              <tr
                                key={unit.id}
                                className="border-t border-[#e2e7e5]"
                              >
                                <td className="px-5 py-3 font-semibold">
                                  {unit.name}
                                  <span className="ml-2 font-mono text-xs text-[#75837f]">
                                    {unit.id}
                                  </span>
                                </td>
                                <td className="px-4 py-3 font-mono">
                                  {unit.validFraction === null
                                    ? '—'
                                    : `${(unit.validFraction * 100).toFixed(1)}%`}
                                </td>
                                <td className="px-4 py-3 font-mono">
                                  {unit.ndvi?.toFixed(3) ?? '—'}
                                </td>
                                <td className="px-4 py-3 font-mono">
                                  {unit.ndmi?.toFixed(3) ?? '—'}
                                </td>
                                <td className="px-4 py-3 font-mono">
                                  {unit.candidateWetlandAreaM2 === null ||
                                  unit.candidateWetlandAreaM2 === undefined
                                    ? '—'
                                    : `${(unit.candidateWetlandAreaM2 / 1_000_000).toFixed(2)} km²`}
                                </td>
                                <td className="px-5 py-3 font-mono">
                                  {unit.accessibilityScore === null ||
                                  unit.accessibilityScore === undefined
                                    ? '—'
                                    : unit.accessibilityScore.toFixed(3)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <p className="px-5 py-3 text-xs leading-5 text-[#6a7874]">
                      生成于 {geeResult.generatedAt} ·{' '}
                      {geeResult.dataSource || 'COPERNICUS/S2_SR_HARMONIZED'} ·{' '}
                      {geeResult.scaleM || 20} m统计尺度。
                      {geeResult.qualityNote}
                    </p>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
        {geeResult?.context && (
          <EvidenceContextPanel context={geeResult.context} />
        )}
        {geeResult?.unitMetrics.length ? (
          <ScreeningScenarioPanel
            key={`${summary?.fileName || 'area'}-${geeResult.unitMetrics.map((unit) => unit.id).join('-')}`}
            units={geeResult.unitMetrics}
            onChange={setScreeningScenario}
          />
        ) : null}
        <WaterDecisionPanel
          evidence={evidence}
          scenario={screeningScenario}
          onPlanChange={setDecisionPlan}
        />

        <section
          className="mt-8 overflow-hidden border border-[#b9c7c3] bg-white shadow-sm"
          aria-labelledby="verification-title"
        >
          <div className="grid lg:grid-cols-[1fr_360px]">
            <div className="p-6 lg:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="eyebrow">
                    <span />
                    STEP 06 · VERIFY
                  </div>
                  <h2
                    id="verification-title"
                    className="mt-2 text-2xl font-semibold text-[#143638]"
                  >
                    历史回测与后续实测
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-[#657672]">
                    先用不同年份的同物候期影像检查排序稳定性。未来若取得真实补水记录，再把实施前后窗口加入验证；数值变化本身不代表补水因果效应。
                  </p>
                </div>
                {geeResult && (
                  <button
                    type="button"
                    className="action-secondary"
                    onClick={() => setBaselineResult(geeResult)}
                  >
                    <ShieldCheck className="size-4" />
                    设为回测基线
                  </button>
                )}
              </div>
              {!baselineResult ? (
                <div className="mt-6 grid min-h-40 place-items-center border border-dashed border-[#bdcbc7] bg-[#f5f8f7] text-center">
                  <div>
                    <Activity className="mx-auto size-7 text-[#6e928a]" />
                    <p className="mt-3 text-sm font-semibold text-[#31534d]">
                      尚未保存基线
                    </p>
                    <p className="mt-1 text-xs text-[#748480]">
                      先完成一次真实分析，再将该时段设为历史回测基线。
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mt-6 grid gap-px border border-[#cbd5d2] bg-[#cbd5d2] sm:grid-cols-3">
                  <Mini
                    label="基线窗口"
                    value={`${baselineResult.start} — ${baselineResult.end}`}
                  />
                  <Mini
                    label="复测状态"
                    value={hasFollowUp ? '已形成前后对照' : '等待新一期结果'}
                  />
                  <Mini
                    label="同指标变化"
                    value={
                      comparableDelta === null
                        ? '待同指标复测'
                        : `${comparableDelta >= 0 ? '+' : ''}${comparableDelta.toFixed(3)}`
                    }
                  />
                </div>
              )}
              {hasFollowUp && (
                <div
                  className={`mt-4 border-l-4 p-4 text-sm leading-6 ${comparableDelta !== null && comparableDelta > 0 ? 'border-[#2f9f80] bg-[#e9f5f1] text-[#215e50]' : 'border-[#c18a32] bg-[#fff7e7] text-[#70541f]'}`}
                >
                  <b>复测判读：</b>
                  {followUpMessage}
                </div>
              )}
              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={exportClosureSummary}
                  disabled={!geeResult}
                  className="action-primary"
                >
                  <BarChart3 className="size-4" />
                  导出闭环证据包
                </button>
                {baselineResult && (
                  <button
                    type="button"
                    onClick={() => setBaselineResult(null)}
                    className="action-secondary"
                  >
                    <RefreshCw className="size-4" />
                    重置基线
                  </button>
                )}
              </div>
            </div>
            <aside className="bg-[#123d3b] p-6 text-white">
              <p className="text-xs tracking-[.16em] text-[#9dc0b9]">
                VALIDATION LIMITS
              </p>
              <h3 className="mt-2 text-lg font-semibold">
                验证边界与最小补充资料
              </h3>
              <ol className="mt-6 space-y-5 text-sm leading-6 text-[#d2e3df]">
                <li className="flex gap-3">
                  <span className="trace-number">1</span>
                  <span>
                    复核县界现势性，并进一步裁出真实滩区或湿地候选斑块。
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="trace-number">2</span>
                  <span>
                    用不同传感器、年份和同期降雨记录交叉检查排序稳定性。
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="trace-number">3</span>
                  <span>
                    条件允许时，在高、中、低优先区布设固定水位与土壤水分样点。
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="trace-number">4</span>
                  <span>
                    只有获得真实水源、渠道、闸门与补水量资料后，才能扩展为工程调度。
                  </span>
                </li>
              </ol>
              <div className="mt-6 flex items-center gap-2 border-t border-white/10 pt-4 text-xs text-[#9dc0b9]">
                <ArrowRight className="size-4" />
                系统完成前期筛查，不替代工程调度与管理审批。
              </div>
            </aside>
          </div>
        </section>
      </div>
    </section>
  );
}

function WorkflowStep({
  index,
  title,
  detail,
  state,
}: {
  index: string;
  title: string;
  detail: string;
  state: 'done' | 'active' | 'idle';
}) {
  return (
    <div className={`workflow-step ${state}`}>
      <span className="font-mono text-xs">
        {state === 'done' ? '✓' : index}
      </span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l-2 border-[#d6a640] bg-[#f0ede4] px-4 py-3">
      <span className="text-xs text-[#6d7975]">{label}</span>
      <strong className="mt-1 block font-mono text-lg">{value}</strong>
    </div>
  );
}
