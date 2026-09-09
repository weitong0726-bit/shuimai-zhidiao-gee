'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  CloudDownload,
  ExternalLink,
  FileJson,
  ImageIcon,
  LoaderCircle,
  Satellite,
  UploadCloud,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { cn } from '@/lib/utils';

type Observation = {
  id: string;
  periodStart: string;
  periodEnd: string;
  ndvi: number | null;
  ndmi: number | null;
  mndwi: number | null;
  validFraction: number;
  sceneCount: number;
  areaM2: number;
  waterFraction: number | null;
};

type ImportSummary = {
  fileName: string;
  observations: Observation[];
  rejected: number;
  confirmed: boolean;
};

export type ImageLayerKey = 'ndvi' | 'ndmi' | 'mndwi' | 'dynamic-world' | 'true-color';
export type ImportedImageLayer = { name: string; url: string };
type PreviewImage = ImportedImageLayer & { key: ImageLayerKey | null };
type RawProperties = Record<string, unknown>;

const indexMeta = {
  ndmi: { label: 'NDMI', color: '#0f766e', note: '植被冠层含水相关指数' },
  ndvi: { label: 'NDVI', color: '#67873b', note: '植被活力相关指数' },
  mndwi: { label: 'MNDWI', color: '#c28a24', note: '开放水体相关指数' },
} as const;

type IndexKey = keyof typeof indexMeta;

export type ImageryImportStatus = {
  fileName: string;
  indices: IndexKey[];
  units: string[];
  recordCount: number;
  confirmed: boolean;
};

type ImageryWorkspaceProps = {
  onStatisticsImported?: (status: ImageryImportStatus | null) => void;
  onImageLayersChange?: (layers: Partial<Record<ImageLayerKey, ImportedImageLayer>>) => void;
};

function finiteOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrEmpty(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function parseObservations(text: string, fileName: string): ImportSummary {
  const data = JSON.parse(text) as { type?: string; features?: unknown[] };
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('文件必须是GEE导出的GeoJSON FeatureCollection。');
  }
  const observations: Observation[] = [];
  let rejected = 0;
  let confirmed = true;
  for (const rawFeature of data.features) {
    const feature = rawFeature as { properties?: RawProperties };
    const p = feature.properties ?? {};
    const id = stringOrEmpty(p.id);
    const periodStart = stringOrEmpty(p.period_start);
    const areaM2 = finiteOrNull(p.area_m2);
    const validFraction = finiteOrNull(p.valid_fraction);
    if (
      !id || !periodStart || areaM2 === null || areaM2 <= 0 ||
      validFraction === null || validFraction < 0 || validFraction > 1 ||
      p.data_source !== 'COPERNICUS/S2_SR_HARMONIZED'
    ) {
      rejected += 1;
      continue;
    }
    const isConfirmed = p.boundary_confirmed === true || p.boundary_confirmed === 1 || p.boundary_confirmed === 'true';
    confirmed = confirmed && isConfirmed;
    const validArea = finiteOrNull(p.valid_area_m2);
    const waterArea = finiteOrNull(p.water_area_valid_m2);
    observations.push({
      id,
      periodStart,
      periodEnd: stringOrEmpty(p.period_end_exclusive),
      ndvi: finiteOrNull(p.ndvi),
      ndmi: finiteOrNull(p.ndmi),
      mndwi: finiteOrNull(p.mndwi),
      validFraction,
      sceneCount: finiteOrNull(p.scene_granules) ?? 0,
      areaM2,
      waterFraction: validArea && waterArea !== null ? Math.max(0, Math.min(1, waterArea / validArea)) : null,
    });
  }
  if (!observations.length) {
    throw new Error('没有读到有效记录。请确认使用了项目提供的GEE脚本，并保留导出字段。');
  }
  observations.sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.id.localeCompare(b.id));
  return { fileName, observations, rejected, confirmed };
}

function formatIndex(value: number | null, digits = 3) {
  return value === null ? '缺测' : value.toFixed(digits);
}

function deltaLabel(delta: number | null) {
  if (delta === null) return '有效时序不足';
  if (Math.abs(delta) < 0.015) return '基本稳定';
  return delta < 0 ? '阶段性下降' : '阶段性上升';
}

function imageLayerKey(fileName: string): ImageLayerKey | null {
  const name = fileName.toLowerCase();
  if (name.includes('mndwi')) return 'mndwi';
  if (name.includes('ndmi')) return 'ndmi';
  if (name.includes('ndvi')) return 'ndvi';
  if (name.includes('dynamic') || /(^|[_-])dw([_.-]|$)/.test(name)) return 'dynamic-world';
  if (name.includes('true') || name.includes('rgb') || name.includes('color')) return 'true-color';
  return null;
}

export function ImageryWorkspace({ onStatisticsImported, onImageLayersChange }: ImageryWorkspaceProps) {
  const [imported, setImported] = useState<ImportSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [unit, setUnit] = useState('H1');
  const [indexKey, setIndexKey] = useState<IndexKey>('ndmi');
  const [previews, setPreviews] = useState<PreviewImage[]>([]);

  useEffect(() => () => previews.forEach((item) => URL.revokeObjectURL(item.url)), [previews]);

  const units = useMemo(
    () => Array.from(new Set(imported?.observations.map((item) => item.id) ?? [])),
    [imported],
  );

  const rows = useMemo(
    () => (imported?.observations ?? []).filter((item) => item.id === unit),
    [imported, unit],
  );

  const validRows = rows.filter((row) => row.validFraction >= 0.7 && row[indexKey] !== null);
  const first = validRows[0]?.[indexKey] ?? null;
  const last = validRows.at(-1)?.[indexKey] ?? null;
  const delta = first === null || last === null ? null : last - first;
  const meanCoverage = rows.length ? rows.reduce((sum, row) => sum + row.validFraction, 0) / rows.length : 0;
  const latest = rows.at(-1) ?? null;

  async function importGeoJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const result = parseObservations(await file.text(), file.name);
      setImported(result);
      const nextUnits = Array.from(new Set(result.observations.map((item) => item.id)));
      setUnit(nextUnits.includes('H1') ? 'H1' : nextUnits[0]);
      const indices = (Object.keys(indexMeta) as IndexKey[]).filter((key) =>
        result.observations.some((item) => item[key] !== null),
      );
      onStatisticsImported?.({
        fileName: result.fileName,
        indices,
        units: nextUnits,
        recordCount: result.observations.length,
        confirmed: result.confirmed,
      });
    } catch (cause) {
      setImported(null);
      onStatisticsImported?.(null);
      setError(cause instanceof Error ? cause.message : '导入失败，请检查文件。');
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  function importImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith('image/'));
    previews.forEach((item) => URL.revokeObjectURL(item.url));
    const next = files.map((file) => ({ name: file.name, url: URL.createObjectURL(file), key: imageLayerKey(file.name) }));
    setPreviews(next);
    const mapped: Partial<Record<ImageLayerKey, ImportedImageLayer>> = {};
    next.forEach((item) => {
      if (item.key) mapped[item.key] = { name: item.name, url: item.url };
    });
    onImageLayersChange?.(mapped);
    event.target.value = '';
  }

  return (
    <section id="imagery" className="border-y border-[#c9c4b6] bg-[#e9e5da] py-16 lg:py-20">
      <div className="mx-auto max-w-7xl px-5 lg:px-8">
        <div className="grid gap-5 lg:grid-cols-[1fr_.78fr] lg:items-end">
          <div>
            <div className="mb-3 flex items-center gap-2 text-xs font-medium tracking-[.16em] text-[#9b6a12]"><span className="h-px w-8 bg-current"/>02 / 遥感数据工作台</div>
            <h2 className="max-w-3xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">把H1/H2影像真正接进分析链</h2>
          </div>
          <p className="max-w-xl text-sm leading-7 text-[#5c6b67]">先在GEE运行项目脚本并导出GeoJSON，再在这里完成字段校验、有效覆盖率检查和NDVI、NDMI、MNDWI时序分析。所有计算均在浏览器本地完成，文件不会上传。</p>
        </div>

        <div className="mt-9 grid gap-3 sm:grid-cols-4">
          <Stage number="01" title="研究区" status="已完成" done detail="H1 / H2，各约1 km²"/>
          <Stage number="02" title="影像检索" status={imported ? '已导入' : '待运行'} done={Boolean(imported)} detail="Sentinel-2 SR，20m统计"/>
          <Stage number="03" title="指数分析" status={imported ? '可分析' : '等待数据'} done={Boolean(imported)} detail="质量门槛 ≥ 70%"/>
          <Stage number="04" title="模型接入" status={imported?.confirmed ? '边界已确认' : '等待确认'} done={Boolean(imported?.confirmed)} detail="不把指数冒充土壤含水率"/>
        </div>

        <div className="mt-6 grid overflow-hidden rounded-xl border border-[#bdb7a9] bg-[#f8f7f2] shadow-sm lg:grid-cols-[350px_1fr]">
          <aside className="border-b border-[#d5d0c4] bg-[#123d38] p-6 text-white lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between">
              <div><div className="text-xs text-[#9ebbb4]">DATA INTAKE</div><h3 className="mt-1 text-xl font-semibold">导入GEE结果</h3></div>
              <Satellite className="size-6 text-[#e0b957]"/>
            </div>

            <ol className="mt-7 space-y-5 text-sm text-[#d2e1dd]">
              <li className="flex gap-3"><StepDot value="1"/><span>下载脚本和H1/H2边界，在GEE Code Editor中运行。</span></li>
              <li className="flex gap-3"><StepDot value="2"/><span>核查底图与影像后，将脚本中的边界确认开关改为 true。</span></li>
              <li className="flex gap-3"><StepDot value="3"/><span>从Tasks导出 <b className="font-medium text-white">shuimai_observations.geojson</b>。</span></li>
            </ol>

            <div className="mt-7 grid gap-2">
              <a className={cn(buttonVariants(), 'justify-between bg-[#d9aa45] text-[#17332f] hover:bg-[#e5ba5c]')} href="/gee-wetland-observations.js" download>下载GEE分析脚本 <CloudDownload className="size-4"/></a>
              <a className={cn(buttonVariants({ variant: 'outline' }), 'justify-between border-white/25 bg-transparent text-white hover:bg-white/10 hover:text-white')} href="/huiji-h1-h2.geojson" download>下载H1/H2边界 <FileJson className="size-4"/></a>
              <a className={cn(buttonVariants({ variant: 'ghost' }), 'justify-between text-[#c8d9d4] hover:bg-white/10 hover:text-white')} href="https://code.earthengine.google.com/" target="_blank" rel="noreferrer">打开Google Earth Engine <ExternalLink className="size-4"/></a>
            </div>

            <div className="mt-7 border-t border-white/10 pt-6">
              <label htmlFor="gee-file" className="mb-2 block text-xs text-[#aac4bd]">GEE统计结果（.geojson / .json）</label>
              <input id="gee-file" type="file" accept=".geojson,.json,application/geo+json,application/json" onChange={importGeoJson} className="h-9 w-full rounded-lg border border-white/20 bg-white/10 px-2 text-sm text-white file:mr-2 file:border-0 file:bg-transparent file:text-white"/>
              {busy && <p className="mt-3 flex items-center gap-2 text-xs text-[#c8d9d4]"><LoaderCircle className="size-3 animate-spin"/>正在解析与校验字段</p>}
              {error && <p role="alert" className="mt-3 flex gap-2 text-xs leading-5 text-[#ffd0c6]"><AlertCircle className="mt-0.5 size-4 shrink-0"/>{error}</p>}
              {imported && <p className="mt-3 flex gap-2 text-xs leading-5 text-[#bde7d5]"><CheckCircle2 className="mt-0.5 size-4 shrink-0"/>已读取{imported.observations.length}条记录{imported.rejected ? `，过滤${imported.rejected}条无效记录` : ''}。</p>}
            </div>
          </aside>

          <div className="min-w-0 p-6 lg:p-8">
            {!imported ? (
              <EmptyAnalysis/>
            ) : (
              <div>
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div><div className="text-xs text-[#687873]">已导入 · {imported.fileName}</div><h3 className="mt-1 text-2xl font-semibold">遥感时序质量与变化</h3></div>
                  <div className="flex gap-2">
                    <NativeSelect aria-label="研究单元" value={unit} onChange={(event) => setUnit(event.target.value)}>
                      {units.map((item) => <NativeSelectOption key={item} value={item}>{item}单元</NativeSelectOption>)}
                    </NativeSelect>
                    <NativeSelect aria-label="遥感指数" value={indexKey} onChange={(event) => setIndexKey(event.target.value as IndexKey)}>
                      {(Object.keys(indexMeta) as IndexKey[]).map((key) => <NativeSelectOption key={key} value={key}>{indexMeta[key].label}</NativeSelectOption>)}
                    </NativeSelect>
                  </div>
                </div>

                <div className="mt-6 grid gap-3 sm:grid-cols-4">
                  <MiniMetric label="时序记录" value={`${rows.length}期`} note={`${validRows.length}期通过质量门槛`}/>
                  <MiniMetric label="平均有效覆盖" value={`${(meanCoverage * 100).toFixed(0)}%`} note={meanCoverage >= .7 ? '可用于趋势判读' : '云覆盖偏高'}/>
                  <MiniMetric label={`最新${indexMeta[indexKey].label}`} value={formatIndex(latest?.[indexKey] ?? null)} note={indexMeta[indexKey].note}/>
                  <MiniMetric label="首末期变化" value={delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`} note={deltaLabel(delta)}/>
                </div>

                <div className="mt-5 rounded-lg border bg-white p-4 sm:p-5">
                  <TimeSeriesChart rows={rows} indexKey={indexKey}/>
                </div>

                <div className="mt-5 overflow-x-auto rounded-lg border bg-white">
                  <table className="w-full min-w-[690px] border-collapse text-left text-sm">
                    <thead className="bg-[#173d38] text-white"><tr>{['周期起日','有效覆盖','场景颗粒','NDVI','NDMI','MNDWI','有效区水体占比'].map((label) => <th key={label} className="px-4 py-3 font-medium">{label}</th>)}</tr></thead>
                    <tbody>{rows.map((row) => <tr key={`${row.id}-${row.periodStart}`} className="border-t even:bg-[#f6f4ee]"><td className="px-4 py-3 font-medium">{row.periodStart}</td><td className={`px-4 py-3 font-mono ${row.validFraction < .7 ? 'font-semibold text-[#a14325]' : ''}`}>{(row.validFraction * 100).toFixed(0)}%</td><td className="px-4 py-3 font-mono">{row.sceneCount}</td><td className="px-4 py-3 font-mono">{formatIndex(row.ndvi)}</td><td className="px-4 py-3 font-mono">{formatIndex(row.ndmi)}</td><td className="px-4 py-3 font-mono">{formatIndex(row.mndwi)}</td><td className="px-4 py-3 font-mono">{row.waterFraction === null ? '—' : `${(row.waterFraction * 100).toFixed(1)}%`}</td></tr>)}</tbody>
                  </table>
                </div>

                <div className={`mt-5 rounded-lg border p-4 text-sm leading-6 ${imported.confirmed ? 'border-[#9ec3b6] bg-[#edf7f3] text-[#285a4d]' : 'border-[#ddba70] bg-[#fff7df] text-[#6d5524]'}`}>
                  <strong className="block">{imported.confirmed ? '数据可进入参数校准环节' : '边界尚未人工确认，暂不送入补水模型'}</strong>
                  <span>{imported.confirmed ? '下一步用遥感变化对H1/H2风险顺序做独立检验；NDMI仍只作为遥感代理变量。' : '请先在GEE卫星底图核查湿地类型、边界与供水连通性，再重新导出。'}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-[#bdb7a9] bg-[#f8f7f2] p-6 lg:p-8">
          <div className="grid gap-6 lg:grid-cols-[330px_1fr]">
            <div><div className="flex items-center gap-3"><ImageIcon className="size-5 text-[#0f766e]"/><h3 className="text-lg font-semibold">导入指数图或真彩色图</h3></div><p className="mt-3 text-sm leading-6 text-[#63716d]">上传PNG、JPG或WebP后，网站会按文件名识别图层并同步到顶部地图。请分别命名为 H1_NDVI.png、H1_NDMI.png、H1_MNDWI.png；GeoTIFF保留作科研归档。</p><input className="mt-5 h-9 w-full rounded-lg border bg-white px-2 text-sm file:mr-2 file:border-0 file:bg-transparent" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={importImages}/></div>
            <div className="grid min-h-48 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {previews.length ? previews.map((item) => <figure key={item.url} className="overflow-hidden rounded-lg border bg-white"><Image src={item.url} alt={item.name} width={640} height={480} unoptimized className="aspect-[4/3] w-full object-contain"/><figcaption className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-[#687873]"><span className="truncate">{item.name}</span><b className={item.key ? 'text-[#0f766e]' : 'text-[#a14325]'}>{item.key ? '已同步地图' : '文件名未识别'}</b></figcaption></figure>) : <div className="grid place-items-center rounded-lg border border-dashed border-[#b7b1a4] bg-white/60 text-center text-sm text-[#73807c] sm:col-span-2 xl:col-span-3"><div><UploadCloud className="mx-auto mb-3 size-7 text-[#8a9893]"/><p>尚未导入展示影像</p><p className="mt-1 text-xs">支持多张PNG、JPG或WebP，仅在当前浏览器预览</p></div></div>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Stage({ number, title, status, detail, done }: { number: string; title: string; status: string; detail: string; done: boolean }) {
  return <div className={`border p-4 ${done ? 'border-[#8db8aa] bg-[#eef7f3]' : 'border-[#c9c4b6] bg-[#f8f7f2]'}`}><div className="flex items-center justify-between"><span className="font-mono text-xs text-[#85775a]">{number}</span>{done ? <CheckCircle2 className="size-4 text-[#0f766e]"/> : <span className="size-2 rounded-full bg-[#c28a24]"/>}</div><div className="mt-5 flex items-baseline justify-between gap-2"><strong>{title}</strong><span className="text-xs text-[#5e706a]">{status}</span></div><p className="mt-1 text-xs text-[#75817d]">{detail}</p></div>;
}

function StepDot({ value }: { value: string }) {
  return <span className="grid size-6 shrink-0 place-items-center rounded-full border border-[#d9aa45]/60 font-mono text-xs text-[#f0cf83]">{value}</span>;
}

function EmptyAnalysis() {
  return <div className="grid min-h-[560px] place-items-center text-center"><div className="max-w-md"><div className="mx-auto grid size-16 place-items-center rounded-full bg-[#e1eee9]"><BarChart3 className="size-7 text-[#0f766e]"/></div><h3 className="mt-5 text-xl font-semibold">等待真实遥感统计</h3><p className="mt-3 text-sm leading-7 text-[#687873]">导入GEE导出的GeoJSON后，这里会自动展示H1/H2的影像有效覆盖率、三类指数时序、水体占比和边界确认状态。</p><div className="mt-5 rounded-lg bg-[#eeeae0] p-4 text-left text-xs leading-5 text-[#68736f]"><strong className="text-[#3f514c]">系统不会做的事：</strong>不会把NDMI直接换算成土壤含水率，也不会在边界未确认时生成正式补水指令。</div></div></div>;
}

function MiniMetric({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="border-l-2 border-[#d6a640] bg-[#f0ede4] px-4 py-3"><div className="text-[11px] text-[#6d7975]">{label}</div><strong className="mt-1 block font-mono text-xl">{value}</strong><p className="mt-1 truncate text-[11px] text-[#76827e]" title={note}>{note}</p></div>;
}

function TimeSeriesChart({ rows, indexKey }: { rows: Observation[]; indexKey: IndexKey }) {
  const usable = rows.filter((row) => row[indexKey] !== null);
  const width = 720;
  const height = 230;
  const pad = { left: 48, right: 24, top: 24, bottom: 42 };
  if (!usable.length) return <div className="grid h-56 place-items-center text-sm text-[#75817d]">当前单元没有{indexMeta[indexKey].label}有效值</div>;
  const values = usable.map((row) => row[indexKey] as number);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (Math.abs(max - min) < .02) { min -= .02; max += .02; }
  else { const margin = (max - min) * .15; min -= margin; max += margin; }
  const x = (index: number) => usable.length === 1 ? width / 2 : pad.left + index * (width - pad.left - pad.right) / (usable.length - 1);
  const y = (value: number) => pad.top + (max - value) * (height - pad.top - pad.bottom) / (max - min);
  const points = usable.map((row, index) => `${x(index)},${y(row[indexKey] as number)}`).join(' ');
  const ticks = [0, 1, 2, 3].map((i) => max - i * (max - min) / 3);
  return <div><div className="mb-3 flex items-center justify-between"><div><strong>{unitLabel(usable[0].id)} · {indexMeta[indexKey].label}时序</strong><p className="mt-1 text-xs text-[#74807c]">低于70%有效覆盖的观测以空心点标记</p></div><span className="text-xs text-[#687873]">{indexMeta[indexKey].note}</span></div><svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" aria-label={`${usable[0].id}单元${indexMeta[indexKey].label}时序图`}>
    <title>{usable[0].id}单元{indexMeta[indexKey].label}时序图</title>
    {ticks.map((tick) => <g key={tick}><line x1={pad.left} x2={width-pad.right} y1={y(tick)} y2={y(tick)} stroke="#d9d6cd"/><text x={pad.left-8} y={y(tick)+4} textAnchor="end" fontSize="11" fill="#697773">{tick.toFixed(2)}</text></g>)}
    <polyline points={points} fill="none" stroke={indexMeta[indexKey].color} strokeWidth="3" strokeLinejoin="round"/>
    {usable.map((row, index) => <g key={row.periodStart}><circle cx={x(index)} cy={y(row[indexKey] as number)} r="5" fill={row.validFraction >= .7 ? indexMeta[indexKey].color : '#fff'} stroke={indexMeta[indexKey].color} strokeWidth="2"/><text x={x(index)} y={height-14} textAnchor="middle" fontSize="10" fill="#697773">{row.periodStart.slice(5)}</text></g>)}
  </svg></div>;
}

function unitLabel(id: string) { return `${id}单元`; }
