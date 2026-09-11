'use client';

import { useState } from 'react';
import { Activity, Download, LoaderCircle } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { diagnoseWater, scenarioDefaults, type WaterParameters, type WeatherDay } from '@/lib/water-diagnosis';

type Observation = { id: string; areaM2: number; NDVI: number | null; NDMI: number | null; MNDWI: number | null; coverage: number | null };
type Evidence = { units: Observation[]; sceneCount: number; source: string; start: string; end: string; generatedAt: string; scale: number };
type Weather = { days: WeatherDay[]; source: string; sourceUrl: string; mode: 'historical' | 'forecast'; gridLocation: number[]; retrievedAt: string; timezone: string };
type Props = { boundary: { features: Array<{ properties: { id: string } }> }; centroid: [number, number]; start: string; end: string; ready: boolean };
const fields: Array<{ key: keyof WaterParameters; label: string; min: number; max: number; step: number }> = [
  { key: 'theta_initial', label: '初始体积含水率（m³/m³）', min: 0, max: 1, step: 0.01 },
  { key: 'theta_critical', label: '生态临界含水率（m³/m³）', min: 0, max: 1, step: 0.01 },
  { key: 'theta_wp', label: '萎蔫点（m³/m³）', min: 0, max: 1, step: 0.01 },
  { key: 'theta_max', label: '容量上限 / 田间持水量（m³/m³）', min: 0, max: 1, step: 0.01 },
  { key: 'root_depth_mm', label: '有效根深（mm）', min: 1, max: 10000, step: 10 },
  { key: 'kc', label: '植被系数 Kc', min: 0, max: 5, step: 0.05 },
  { key: 'effective_rain_fraction', label: '有效降水比例（0—1）', min: 0, max: 1, step: 0.05 },
  { key: 'net_loss_mm_day', label: '日净损失（mm/天）', min: 0, max: 100, step: 0.1 },
];
const value = (n: number | null | undefined, digits = 3) => typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '缺测';
const buttonClass = 'inline-flex items-center gap-2 rounded-md bg-[#176356] px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50';

async function loadWeather(start: string, centroid: [number, number]) {
  const local = `/api/weather?${new URLSearchParams({ latitude: String(centroid[1]), longitude: String(centroid[0]), start })}`;
  const first = await fetch(local, { signal: AbortSignal.timeout(30000) });
  if (first.ok) return first.json() as Promise<Weather>;
  const localError = (await first.json()) as { error?: string };
  if (!/429|频繁|暂不可用/.test(localError.error || '')) throw new Error(localError.error || '气象读取失败');
  const end = new Date(Date.parse(start) + 6 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const archive = Date.parse(end) <= Date.parse(today) - 7 * 86400000;
  const url = new URL(archive ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: centroid[1].toFixed(4), longitude: centroid[0].toFixed(4), start_date: start, end_date: end, daily: 'precipitation_sum,et0_fao_evapotranspiration', timezone: 'GMT', ...(archive ? { models: 'era5' } : {}) }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`气象服务暂不可用（${response.status}），请稍后再试。`);
  const data = await response.json() as { latitude: number; longitude: number; daily_units?: Record<string, string>; daily?: { time: string[]; precipitation_sum: Array<number | null>; et0_fao_evapotranspiration: Array<number | null> } };
  const daily = data.daily;
  if (!daily || daily.time?.length !== 7 || data.daily_units?.precipitation_sum !== 'mm' || data.daily_units?.et0_fao_evapotranspiration !== 'mm') throw new Error('气象数据不足7天或单位不符。');
  const days = daily.time.map((date, i) => {
    const rain = daily.precipitation_sum[i], et0 = daily.et0_fao_evapotranspiration[i];
    if (date !== new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10) || typeof rain !== 'number' || !Number.isFinite(rain) || rain < 0 || typeof et0 !== 'number' || !Number.isFinite(et0) || et0 < 0) throw new Error('气象数据存在缺测或日期不连续，请更换窗口。');
    return { date, rain, et0 };
  });
  return { days, source: archive ? 'Open-Meteo / ERA5 历史再分析' : 'Open-Meteo 多模式天气预报', sourceUrl: url.toString(), mode: archive ? 'historical' as const : 'forecast' as const, gridLocation: [data.longitude, data.latitude], retrievedAt: new Date().toISOString(), timezone: 'UTC' };
}

export function WaterDiagnosisPanel({ boundary, centroid, start, end, ready }: Props) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [weatherStart, setWeatherStart] = useState(end);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(boundary.features[0].properties.id);
  const [parameters, setParameters] = useState<Record<string, WaterParameters>>(() => Object.fromEntries(boundary.features.map((f) => [f.properties.id, { ...scenarioDefaults }])));
  const [sources, setSources] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [results, setResults] = useState<Array<Observation & ReturnType<typeof diagnoseWater>> | null>(null);
  const selectedResult = results?.find((row) => row.id === selected);
  const editable = parameters[selected];

  async function loadEvidence() {
    setBusy(true); setError(''); setResults(null); setEvidence(null); setWeather(null);
    const request = async (url: string, init?: RequestInit) => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(180000) });
      const payload = await response.json();
      if (!response.ok) throw new Error((payload as { error?: string }).error || '数据读取失败');
      return payload;
    };
    try {
      const [remote, meteo] = await Promise.allSettled([
        request('/api/gee', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boundary, start, end, index: 'NDMI', mode: 'diagnosis' }) }),
        loadWeather(weatherStart, centroid),
      ]);
      const messages: string[] = [];
      if (remote.status === 'fulfilled') {
        const payload = remote.value as Evidence;
        if (!Array.isArray(payload.units) || payload.units.length !== boundary.features.length || boundary.features.some((f) => !payload.units.some((u) => u.id === f.properties.id && Number.isFinite(u.areaM2) && u.areaM2 > 0))) messages.push('逐单元遥感结果不完整，请重新读取。');
        else setEvidence(payload);
      } else messages.push(`遥感：${remote.reason instanceof Error ? remote.reason.message : '读取失败'}`);
      if (meteo.status === 'fulfilled') setWeather(meteo.value as Weather);
      else messages.push(`气象：${meteo.reason instanceof Error ? meteo.reason.message : '读取失败'}`);
      setError(messages.join('；'));
    } finally { setBusy(false); }
  }

  function simulate() {
    if (!evidence || !weather || !confirmed) return;
    setError(''); setResults(null);
    try {
      const computed = evidence.units.map((unit) => {
        try { return { ...unit, ...diagnoseWater(unit.areaM2, parameters[unit.id], weather.days) }; }
        catch (cause) { throw new Error(`${unit.id}：${cause instanceof Error ? cause.message : '参数无效'}`); }
      });
      setResults(computed.sort((a, b) => b.loss - a.loss));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '模拟失败'); }
  }

  function exportReport() {
    if (!results || !evidence || !weather) return;
    const report = { title: '水脉智调 · 七天缺水诊断', method: '根区水量平衡；不补水基线；权重为1；参数为用户输入或待校准假设；非调度指令', exportedAt: new Date().toISOString(), boundary, evidence, weather, parameters, parameterSources: Object.fromEntries(evidence.units.map((u) => [u.id, sources[u.id]?.trim() || '申报书情景默认值，未校准'])), results };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `shuimai_diagnosis_${weatherStart}.json`; link.click(); URL.revokeObjectURL(url);
  }

  return <section className="mt-6 rounded-xl border border-[#95b7ac] bg-[#f0f7f3] p-5 sm:p-6" aria-labelledby="diagnosis-title">
    <div className="flex items-center gap-3"><Activity className="size-6 text-[#176356]"/><div><p className="text-sm text-[#65766f]">第3步 · 监测之后，诊断缺水</p><h2 id="diagnosis-title" className="text-xl font-semibold">哪些地块需要重点关注？</h2></div></div>
    <p className="mt-4 text-base leading-7 text-[#45675f]">分别读取每个面要素的遥感证据，结合降水、参考蒸散和根区参数，计算不补水情况下连续7天的缺水变化。</p>
    <div className="mt-5 flex flex-wrap items-end gap-3">
      <label className="text-sm font-medium">7天模拟起始日（UTC）<input type="date" value={weatherStart} disabled={busy} onChange={(e) => { setWeatherStart(e.target.value); setWeather(null); setResults(null); }} className="mt-2 block rounded-md border bg-white px-3 py-2.5"/></label>
      <button type="button" disabled={busy} className="rounded-md border border-[#95b7ac] px-3 py-3 text-sm" onClick={() => { setWeatherStart(new Date().toISOString().slice(0, 10)); setWeather(null); setResults(null); }}>从今天预测</button>
      <button className={buttonClass} disabled={!ready || busy || !weatherStart || !start || !end || start >= end} onClick={loadEvidence}>{busy && <LoaderCircle className="size-4 animate-spin"/>}{busy ? '正在读取逐地块数据…' : '读取诊断数据'}</button>
    </div>
    <p className="mt-3 text-sm leading-6 text-[#65766f]">遥感窗口：{start} 至 {end}（不含结束日）。历史窗口使用ERA5回放，结束日需距今天至少7天；今天及以后使用天气预报。每个面要素作为独立候选单元，MultiPolygon不会自动拆分。</p>
    {Date.parse(weatherStart) < Date.parse(end) && <p className="mt-2 text-sm text-[#9b6010]">遥感窗口晚于模拟起点：仅可用于回顾性对照，不能作为当时已知的预测证据。</p>}
    {error && <p role="alert" className="mt-4 rounded-lg bg-[#f8dfd8] p-3 text-sm leading-6 text-[#803426]">{error}</p>}
    {evidence && <div className="mt-5 rounded-lg border bg-white p-4"><h3 className="mb-3 font-semibold">逐单元遥感证据</h3><Table><TableHeader><TableRow>{['单元', '面积 ha', 'NDVI', 'NDMI', 'MNDWI', '有效覆盖', '质量'].map((s) => <TableHead key={s}>{s}</TableHead>)}</TableRow></TableHeader><TableBody>{evidence.units.map((u) => <TableRow key={u.id}><TableCell>{u.id}</TableCell><TableCell>{value(u.areaM2 / 10000, 2)}</TableCell><TableCell>{value(u.NDVI)}</TableCell><TableCell>{value(u.NDMI)}</TableCell><TableCell>{value(u.MNDWI)}</TableCell><TableCell>{value(typeof u.coverage === 'number' ? u.coverage * 100 : null, 1)}%</TableCell><TableCell className={typeof u.coverage === 'number' && u.coverage >= 0.7 ? 'text-[#176356]' : 'text-[#a14d25]'}>{typeof u.coverage === 'number' && u.coverage >= 0.7 ? '覆盖达标' : '证据不足'}</TableCell></TableRow>)}</TableBody></Table><p className="mt-3 text-sm leading-6 text-[#65766f]">{evidence.sceneCount}景候选影像，SCL像元掩膜后中位数合成，20m统计。覆盖≥70%为项目质量门槛，不代表地类已经核实；缺测不按0处理。</p></div>}
    {weather && <div className="mt-4 rounded-lg border bg-white p-4"><h3 className="font-semibold">{weather.mode === 'historical' ? '历史气象回放' : '未来气象预报'} · {weather.source}</h3><p className="my-2 text-sm text-[#65766f]">返回网格：{weather.gridLocation.map((n) => value(n, 3)).join(', ')} · UTC日界。所有单元共用研究区中心附近的气象网格，不代表地块实测。</p><Table><TableHeader><TableRow><TableHead>日期</TableHead><TableHead>降水 mm</TableHead><TableHead>参考蒸散 ET₀ mm</TableHead></TableRow></TableHeader><TableBody>{weather.days.map((d) => <TableRow key={d.date}><TableCell>{d.date}</TableCell><TableCell>{value(d.rain, 2)}</TableCell><TableCell>{value(d.et0, 2)}</TableCell></TableRow>)}</TableBody></Table><a href={weather.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm underline">查看原始气象数据</a></div>}
    {evidence && weather && <>
      <div className="mt-5 rounded-lg border border-[#baccc4] bg-white p-4"><h3 className="font-semibold">确认根区参数</h3><p className="my-3 text-sm leading-6 text-[#65766f]">NDMI反映冠层水分，不能直接换算土壤含水率。下列默认值来自申报书的假设单元A，所有地块初始相同；请逐一修改并记录来源。适用于根区土壤水桶情景，不适用于开放水体水位调度。</p>
        <label className="flex flex-wrap items-center gap-3 text-sm">当前地块<NativeSelect value={selected} onChange={(e) => setSelected(e.target.value)}>{evidence.units.map((u) => <option key={u.id} value={u.id}>{u.id}</option>)}</NativeSelect></label>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">{fields.map((f) => <label key={f.key} className="text-sm">{f.label}<input type="number" min={f.min} max={f.max} step={f.step} value={Number.isFinite(editable[f.key]) ? editable[f.key] : ''} onChange={(e) => { setParameters({ ...parameters, [selected]: { ...editable, [f.key]: e.target.value === '' ? NaN : Number(e.target.value) } }); setResults(null); setConfirmed(false); }} className="mt-2 block w-full rounded-md border px-3 py-2.5"/></label>)}</div>
        <label className="mt-4 block text-sm">参数来源 / 初始含水率对应日期<input value={sources[selected] || ''} placeholder="未填写则按情景假设记录；可填实测日期或文献" onChange={(e) => { setSources({ ...sources, [selected]: e.target.value }); setResults(null); setConfirmed(false); }} className="mt-2 block w-full rounded-md border px-3 py-2.5"/></label>
        <label className="mt-4 flex items-start gap-3 text-sm leading-6"><Checkbox className="mt-1 shrink-0" checked={confirmed} onCheckedChange={(checked) => { setConfirmed(checked === true); setResults(null); }}/><span>我已检查所有单元参数，初始状态对应模拟起点；默认值和未核实地块仅用于情景研究。</span></label>
      </div>
      <button className={`${buttonClass} mt-4`} disabled={!confirmed || busy} onClick={simulate}>计算7天不补水缺水诊断</button>
    </>}
    {results && weather && <div className="mt-5 rounded-lg border border-[#95b7ac] bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-lg font-semibold">{weather.mode === 'historical' ? '历史情景诊断结果' : '7天情景预测结果'}</h3><button onClick={exportReport} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><Download className="size-4"/>下载完整诊断报告</button></div>
      <p className="my-3 text-sm leading-6 text-[#65766f]">按面积加权累计缺水指标降序排列，权重均为1。初始缺水体积是根区达到阈值的净缺口，尚未考虑输水效率与预算，不能作为补水处方。</p>
      <Table><TableHeader><TableRow>{['单元', '阈下天数', '初始净缺口 m³', '累计缺水 ha·天', '最高亏缺比例'].map((s) => <TableHead key={s}>{s}</TableHead>)}</TableRow></TableHeader><TableBody>{results.map((r) => <TableRow key={r.id}><TableCell><button className="font-semibold underline" onClick={() => setSelected(r.id)}>{r.id}</button></TableCell><TableCell>{r.deficitDays}/7</TableCell><TableCell>{value(r.initialDeficitM3, 1)}</TableCell><TableCell>{value(r.loss, 3)}</TableCell><TableCell>{value(r.maxDeficitRatio * 100, 1)}%</TableCell></TableRow>)}</TableBody></Table>
      {selectedResult && <><h4 className="mb-2 mt-5 font-semibold">{selected} · 每日根区状态</h4><Table><TableHeader><TableRow><TableHead>日期</TableHead><TableHead>模拟含水率</TableHead><TableHead>生态阈值</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{selectedResult.trajectory.map((d) => <TableRow key={d.date}><TableCell>{d.date}</TableCell><TableCell>{value(d.theta)}</TableCell><TableCell>{value(parameters[selected].theta_critical)}</TableCell><TableCell className={d.deficitRatio > 1e-10 ? 'text-[#a14d25]' : 'text-[#176356]'}>{d.deficitRatio > 1e-10 ? '低于阈值' : '未低于阈值'}</TableCell></TableRow>)}</TableBody></Table></>}
      <p className="mt-4 text-sm leading-6 text-[#65766f]">模型：前日储水 + 有效降水 − 溢流 − 实际蒸散 − 净损失。该结果用于筛查和参数校准，未验证预测精度、生态恢复效果或减碳效益。</p>
    </div>}
    <p className="mt-5 text-sm text-[#65766f]">数据说明：<a className="underline" href="https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED" target="_blank" rel="noreferrer">Sentinel-2</a> · <a className="underline" href="https://open-meteo.com/en/docs/historical-weather-api" target="_blank" rel="noreferrer">ERA5与参考蒸散</a></p>
  </section>;
}
