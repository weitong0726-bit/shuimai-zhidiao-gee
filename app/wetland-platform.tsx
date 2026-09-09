'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BrainCircuit,
  CheckCircle2,
  CloudRain,
  Database,
  Download,
  Droplets,
  ExternalLink,
  FileJson,
  FlaskConical,
  Gauge,
  Layers3,
  LocateFixed,
  MapPinned,
  Satellite,
  SlidersHorizontal,
} from 'lucide-react';
import {
  ImageryWorkspace,
  type ImageLayerKey,
  type ImageryImportStatus,
  type ImportedImageLayer,
} from './imagery-workspace';

type ScenarioRecord = {
  start: string;
  budget_m3: number;
  kc_factor: number;
  strategy: string;
  used_m3: number;
  loss: number;
};

type MatrixFile = {
  status: string;
  note: string;
  records: ScenarioRecord[];
};

type LayerKey = 'scope' | 'ndvi' | 'ndmi' | 'mndwi' | 'dynamic-world';

const layers: { key: LayerKey; name: string; detail: string; color: string }[] = [
  { key: 'scope', name: '研究区边界', detail: '郑州滩区 / 惠济 / H1 / H2', color: '#ecae3e' },
  { key: 'ndvi', name: 'NDVI 植被活力', detail: 'Sentinel-2 · 20 m', color: '#7fb45b' },
  { key: 'ndmi', name: 'NDMI 冠层含水', detail: '遥感代理变量', color: '#55b5a8' },
  { key: 'mndwi', name: 'MNDWI 开放水体', detail: '水体敏感性核查', color: '#62a9d5' },
  { key: 'dynamic-world', name: 'Dynamic World', detail: '植被 / 水体 / 耕地辅助', color: '#ae87cf' },
];

const windows = [
  { value: '2025-06-01', label: '06.01—06.07' },
  { value: '2025-06-08', label: '06.08—06.14' },
  { value: '2025-06-15', label: '06.15—06.21' },
  { value: '2025-06-22', label: '06.22—06.28' },
];

const budgets = [0, 1000, 2000, 3000, 4000, 5000];
const kcFactors = [0.8, 1, 1.2];

const fallbackAtDefault: ScenarioRecord[] = [
  { start: '2025-06-01', budget_m3: 3000, kc_factor: 1, strategy: '不补水', used_m3: 0, loss: 58.62810531135532 },
  { start: '2025-06-01', budget_m3: 3000, kc_factor: 1, strategy: '面积比例', used_m3: 3000, loss: 38.231 },
  { start: '2025-06-01', budget_m3: 3000, kc_factor: 1, strategy: '初始缺水量比例', used_m3: 3000, loss: 30.059885531135535 },
  { start: '2025-06-01', budget_m3: 3000, kc_factor: 1, strategy: '七天缺水指标优化', used_m3: 3000, loss: 30.059885531135535 },
];

const units = {
  H1: {
    coordinate: '113.54467°E / 34.92490°N',
    area: '1.00 km²',
    note: '位于惠济候选范围西部，仅为几何内接筛出的遥感核查窗口。',
  },
  H2: {
    coordinate: '113.72818°E / 34.89379°N',
    area: '1.00 km²',
    note: '位于惠济候选范围东部，仅为几何内接筛出的遥感核查窗口。',
  },
};

const prescription = [
  { id: 'A', name: '假设湿草地 A', supply: 1700, days: 6, finalTheta: 0.140, accent: '#d3972c' },
  { id: 'B', name: '假设湿草地 B', supply: 0, days: 5, finalTheta: 0.154, accent: '#759997' },
  { id: 'C', name: '假设湿草地 C', supply: 1300, days: 5, finalTheta: 0.139, accent: '#4d8e68' },
];

const strategyColor: Record<string, string> = {
  不补水: '#85908c',
  面积比例: '#7aa79c',
  初始缺水量比例: '#d6a247',
  七天缺水指标优化: '#1c7766',
};

function fmt(value: number, digits = 2) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function WetlandPlatform() {
  const [entryMode, setEntryMode] = useState<'demo' | 'real' | null>(null);
  const [activeLayer, setActiveLayer] = useState<LayerKey>('scope');
  const [unit, setUnit] = useState<'H1' | 'H2'>('H1');
  const [windowStart, setWindowStart] = useState('2025-06-01');
  const [budget, setBudget] = useState(3000);
  const [kc, setKc] = useState(1);
  const [records, setRecords] = useState<ScenarioRecord[]>(fallbackAtDefault);
  const [matrixReady, setMatrixReady] = useState(false);
  const [imageryStatus, setImageryStatus] = useState<ImageryImportStatus | null>(null);
  const [imageLayers, setImageLayers] = useState<Partial<Record<ImageLayerKey, ImportedImageLayer>>>({});

  useEffect(() => {
    fetch('/wetland-data/scenario_matrix.json')
      .then((response) => {
        if (!response.ok) throw new Error('matrix unavailable');
        return response.json() as Promise<MatrixFile>;
      })
      .then((data) => {
        setRecords(data.records);
        setMatrixReady(true);
      })
      .catch(() => setMatrixReady(false));
  }, []);

  const scenario = useMemo(() => {
    const found = records.filter(
      (record) =>
        record.start === windowStart &&
        record.budget_m3 === budget &&
        Math.abs(record.kc_factor - kc) < 0.001,
    );
    return found.length ? found : fallbackAtDefault;
  }, [records, windowStart, budget, kc]);

  const noWater = scenario.find((item) => item.strategy === '不补水')?.loss ?? 0;
  const optimized = scenario.find((item) => item.strategy === '七天缺水指标优化');
  const area = scenario.find((item) => item.strategy === '面积比例');
  const saved = noWater > 0 && optimized ? (1 - optimized.loss / noWater) * 100 : 0;
  const advantage = area && optimized ? area.loss - optimized.loss : 0;
  const isDetailedDemo = windowStart === '2025-06-01' && budget === 3000 && kc === 1;
  const layer = layers.find((item) => item.key === activeLayer) ?? layers[0];
  const activeImage = activeLayer === 'scope' ? null : imageLayers[activeLayer];
  const hasActiveStatistics = activeLayer !== 'scope' && activeLayer !== 'dynamic-world' && imageryStatus?.indices.includes(activeLayer);

  function layerStatus(key: LayerKey) {
    if (key === 'scope') return { label: '已接入', className: 'ready' };
    if (imageLayers[key]) return { label: '图像已接入', className: 'ready' };
    if (key !== 'dynamic-world' && imageryStatus?.indices.includes(key)) return { label: '统计已接入', className: 'ready' };
    return { label: '待导入', className: 'waiting' };
  }

  function chooseLayer(key: LayerKey) {
    setActiveLayer(key);
    if (layerStatus(key).className === 'waiting') {
      window.setTimeout(() => document.getElementById('map-import')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250);
    }
  }

  function startPath(mode: 'demo' | 'real') {
    setEntryMode(mode);
    if (mode === 'demo') {
      setWindowStart('2025-06-01');
      setBudget(3000);
      setKc(1);
    } else {
      setActiveLayer('scope');
      setUnit('H1');
    }
    window.setTimeout(() => {
      document.getElementById(mode === 'demo' ? 'scenario' : 'workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  }

  return (
    <main className="shuimai-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="返回水脉智调首页">
          <span className="brand-icon"><Droplets size={21} /></span>
          <span><strong>水脉智调</strong><small>SHUIMAI ECO-WATER DECISION</small></span>
        </a>
        <nav aria-label="主导航">
          <a href="#top">开始使用</a>
          <a href="#workspace">研究区</a>
          <a href="#scenario">情景推演</a>
          <a href="#imagery">GEE 数据</a>
          <a href="#evidence">项目依据</a>
        </nav>
        <div className="header-status"><span className="status-dot" />技术原型 · 赛道 8.2</div>
      </header>

      <section id="top" className="hero">
        <div className="hero-intro">
          <span className="kicker">第一步 · 确认研究区，再选择使用方式</span>
          <h1>欢迎进入<br />水脉智调。</h1>
          <p>当前研究范围为郑州沿黄滩区—惠济候选范围，H1、H2 是两个待核查的遥感窗口。你可以直接体验已有情景，也可以从真实 GEE 数据开始分析。</p>
          <div className="scope-confirmation">
            <CheckCircle2 size={18} />
            <span><b>研究区已准备</b>郑州滩区候选交集 140.01 km² · H1/H2 各约 1 km²</span>
          </div>
        </div>
        <div className="entry-gateway" aria-label="选择使用方式">
          <div className="entry-heading"><span>接下来你想做什么？</span><small>首次访问建议先体验示范决策</small></div>
          <button className={`entry-choice demo ${entryMode === 'demo' ? 'selected' : ''}`} aria-pressed={entryMode === 'demo'} onClick={() => startPath('demo')}>
            <span className="entry-icon"><FlaskConical size={22} /></span>
            <span className="entry-copy"><b>体验示范决策</b><small>不需要登录 GEE，直接调整水量并查看策略与处方。</small><em>选择窗口 → 设置预算 → 查看处方</em></span>
            <ArrowRight size={19} />
          </button>
          <button className={`entry-choice real ${entryMode === 'real' ? 'selected' : ''}`} aria-pressed={entryMode === 'real'} onClick={() => startPath('real')}>
            <span className="entry-icon"><Satellite size={22} /></span>
            <span className="entry-copy"><b>创建真实分析</b><small>从 H1/H2 核查开始，在 GEE 运行脚本并导入结果。</small><em>选择区域 → 运行 GEE → 导入数据</em></span>
            <ArrowRight size={19} />
          </button>
          <a className="entry-download" href="/wetland-data/demo.json" download><Download size={14} />下载可复现实验数据</a>
        </div>
      </section>

      <section className="quick-guide" aria-label="使用流程">
        <span>使用流程</span>
        <div><b>01</b><em>确认研究区</em></div><ArrowRight size={14} />
        <div><b>02</b><em>选择示范或真实分析</em></div><ArrowRight size={14} />
        <div><b>03</b><em>运行诊断与优化</em></div><ArrowRight size={14} />
        <div><b>04</b><em>查看七天补水处方</em></div>
      </section>

      <section id="workspace" className="workspace-shell">
        <aside className="layer-sidebar">
          <PanelTitle icon={<Layers3 size={15} />} title="数据图层" meta="LAYER CONTROL" />
          <div className="layer-list">
            {layers.map((item) => {
              const status = layerStatus(item.key);
              return <button key={item.key} className={`layer-row ${activeLayer === item.key ? 'active' : ''}`} onClick={() => chooseLayer(item.key)}>
                <span className="layer-swatch" style={{ background: item.color }} />
                <span><b>{item.name}</b><small>{item.detail}</small></span>
                <em className={status.className}>{status.label}</em>
              </button>;
            })}
          </div>

          <div className="data-card">
            <span className="data-card-label"><Database size={13} /> 数据来源</span>
            <dl>
              <div><dt>区域筛选</dt><dd>归档边界</dd></div>
              <div><dt>遥感</dt><dd>Sentinel-2 SR</dd></div>
              <div><dt>地类辅助</dt><dd>Dynamic World</dd></div>
              <div><dt>气象</dt><dd>Open-Meteo / ERA5</dd></div>
            </dl>
          </div>
          <a className="sidebar-download" href="/wetland-data/huiji-candidate.geojson" download><FileJson size={14} /> 下载惠济候选边界</a>
        </aside>

        <div className="map-stage">
          <div className="map-toolbar">
            <div><MapPinned size={15} /><span>郑州沿黄滩区 → 惠济候选范围</span></div>
            <div className="map-scale"><i /> 10 km</div>
          </div>
          <div className="map-canvas">
            {activeImage ? (
              <Image src={activeImage.url} alt={`${layer.name}导入图像：${activeImage.name}`} fill unoptimized sizes="(max-width: 900px) 100vw, 62vw" className="imported-layer-map" />
            ) : (
              <Image src="/boundary-screening.png" alt="郑州滩区与惠济 H1 H2 核查窗口边界筛选图" fill priority sizes="(max-width: 900px) 100vw, 62vw" className="boundary-map" />
            )}
            {!activeImage && <>
              <button className={`map-pin pin-h1 ${unit === 'H1' ? 'selected' : ''}`} onClick={() => setUnit('H1')}><span>H1</span><small>核查窗口</small></button>
              <button className={`map-pin pin-h2 ${unit === 'H2' ? 'selected' : ''}`} onClick={() => setUnit('H2')}><span>H2</span><small>核查窗口</small></button>
            </>}
            {activeLayer !== 'scope' && !activeImage && (
              <div className="pending-layer">
                {hasActiveStatistics ? <CheckCircle2 size={20} /> : <Satellite size={20} />}
                <div><b>{hasActiveStatistics ? `${layer.name}统计已接入` : `${layer.name}尚未接入`}</b><span>{hasActiveStatistics ? `已读取${imageryStatus?.recordCount ?? 0}条时序记录；如需在地图显示，请上传文件名包含${activeLayer.toUpperCase()}的PNG/JPG。` : '运行项目GEE脚本后，在下方导入真实GeoJSON或对应指数图。'}</span></div>
                <a href="#imagery">{hasActiveStatistics ? '查看时序或上传图像' : '进入GEE导入模块'}</a>
              </div>
            )}
            {activeImage && <div className="imported-map-label"><CheckCircle2 size={14} /><span><b>{layer.name}</b>{activeImage.name} · 浏览器本地预览</span></div>}
          </div>
          <div className="map-footer">
            <span><i className="legend candidate" />惠济候选范围</span>
            <span><i className="legend inspect" />H1 / H2 核查窗口</span>
            <strong>空间初筛 ≠ 已确认湿地或补水管理单元</strong>
          </div>
        </div>

        <aside className="unit-sidebar">
          <PanelTitle icon={<LocateFixed size={15} />} title="单元诊断" meta="INSPECTION UNIT" />
          <div className="unit-tabs">
            {(['H1', 'H2'] as const).map((id) => <button key={id} onClick={() => setUnit(id)} className={unit === id ? 'active' : ''}>{id}</button>)}
          </div>
          <div className="unit-heading"><span>{unit}</span><div><b>遥感核查窗口</b><small>{units[unit].coordinate}</small></div></div>
          <div className={`verification-state ${imageryStatus ? 'imported' : ''}`}>{imageryStatus ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}<span><b>{imageryStatus ? 'GEE统计已接入' : '等待 GEE 影像判读'}</b>{imageryStatus ? `${imageryStatus.recordCount}条记录，包含${imageryStatus.units.join('、')}；仍需核查湿地类型与供水连通性` : '尚未确认湿地类型、边界与供水连通性'}</span></div>
          <dl className="unit-stats">
            <div><dt>几何面积</dt><dd>{units[unit].area}</dd></div>
            <div><dt>影像尺度</dt><dd>20 m</dd></div>
            <div><dt>有效覆盖门槛</dt><dd>≥ 70%</dd></div>
            <div><dt>当前数据状态</dt><dd className={imageryStatus ? 'connected' : 'amber'}>{imageryStatus ? '统计已接入' : '待导入'}</dd></div>
          </dl>
          <p className="unit-note">{units[unit].note}</p>
          <div className="assumption-card">
            <span>后续校准参数</span>
            <div><b>θ 初值 / 临界值</b><em>0.18 / 0.23（情景假设）</em></div>
            <div><b>根区深度</b><em>400 mm（情景假设）</em></div>
            <div><b>灌溉效率</b><em>0.80（情景假设）</em></div>
          </div>
        </aside>
      </section>

      <section id="scenario" className="scenario-section">
        <div className="section-heading">
          <div><span className="kicker">DECISION LAB / 已接入公开历史实验矩阵</span><h2>有限水量情景推演</h2><p>选择历史 7 天窗口、可用生态水量与 Kc 系数，系统从 288 条已生成结果中读取四种策略的累计缺水指标。</p></div>
          <div className={`data-integrity ${matrixReady ? 'online' : ''}`}><CheckCircle2 size={15} />{matrixReady ? '实验矩阵加载完成' : '正在使用默认情景'}</div>
        </div>

        <div className="decision-grid">
          <div className="controls-card">
            <div className="card-title"><SlidersHorizontal size={16} /><b>情景参数</b><small>共 72 种组合</small></div>
            <Control label="历史窗口" hint="四个互不重叠的 7 天窗口">
              <select value={windowStart} onChange={(event) => setWindowStart(event.target.value)}>{windows.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
            </Control>
            <Control label="可用补水预算" hint="离散步长为 100 m³">
              <div className="segmented six">{budgets.map((value) => <button key={value} className={budget === value ? 'active' : ''} onClick={() => setBudget(value)}>{value / 1000}k</button>)}</div>
            </Control>
            <Control label="作物系数 Kc" hint="用于检验参数敏感性">
              <div className="segmented">{kcFactors.map((value) => <button key={value} className={kc === value ? 'active' : ''} onClick={() => setKc(value)}>{value.toFixed(1)}</button>)}</div>
            </Control>
            <div className="model-note"><FlaskConical size={15} /><span><b>模型内情景，不是现场验证</b>单位参数 A/B/C 为比赛原型假设；遥感接入后用于校准优先级，而非直接把 NDMI 当作土壤含水率。</span></div>
          </div>

          <div className="comparison-card">
            <div className="card-title"><BarChart3 size={16} /><b>策略对照</b><small>累计缺水指标，越低越好</small></div>
            <div className="bars">
              {scenario.map((item) => {
                const width = noWater ? Math.max(2, item.loss / noWater * 100) : 2;
                return <div className="bar-row" key={item.strategy}><div><span>{item.strategy}</span><b>{fmt(item.loss, 3)}</b></div><div className="bar-track"><i style={{ width: `${width}%`, background: strategyColor[item.strategy] ?? '#777' }} /></div><small>使用 {item.used_m3.toLocaleString()} m³</small></div>;
              })}
            </div>
            <div className="outcome-strip">
              <Metric icon={<Gauge size={16} />} label="相对不补水下降" value={`${fmt(saved, 1)}%`} />
              <Metric icon={<Activity size={16} />} label="较面积比例再减少" value={advantage > 0 ? fmt(advantage, 3) : '0.000'} />
              <Metric icon={<Droplets size={16} />} label="优化策略实际用水" value={`${optimized?.used_m3.toLocaleString() ?? 0} m³`} />
            </div>
          </div>

          <div className="explain-card">
            <div className="card-title"><BrainCircuit size={16} /><b>决策解释器</b><small>基于当前结果自动生成</small></div>
            <div className="explain-status"><span className="pulse" />当前最优策略</div>
            <h3>七天缺水指标优化</h3>
            <p>在 {windows.find((item) => item.value === windowStart)?.label}、预算 {budget.toLocaleString()} m³、Kc={kc.toFixed(1)} 的模型情景中，优化策略累计缺水指标为 <b>{fmt(optimized?.loss ?? 0, 3)}</b>。</p>
            <ul>
              <li>动态规划以 100 m³ 为步长搜索分配组合。</li>
              <li>{saved > 0 ? `相对不补水情景降低 ${fmt(saved, 1)}%。` : '当前无可用水量，四种策略结果相同。'}</li>
              <li>{advantage > 0.01 ? `较面积比例策略继续降低 ${fmt(advantage, 3)}。` : '与基线分配策略表现接近，应结合可解释性选择。'}</li>
            </ul>
            <p className="explain-boundary">输出仅用于比赛原型与方案论证，不构成工程调度指令。</p>
          </div>
        </div>

        <div className="prescription-card">
          <div className="prescription-copy">
            <span className="kicker">7-DAY ECO-WATER PRESCRIPTION</span>
            <h3>可复核的 7 天补水处方单</h3>
            {isDetailedDemo ? <p>当前为申报书中的完整演示情景：2025-06-01 起、预算 3,000 m³、Kc=1.0。下列单元分配直接读取原型输出。</p> : <p>当前组合已展示策略总指标；A/B/C 的逐单元轨迹只在 06.01 / 3,000 m³ / Kc=1.0 的公开演示文件中保存。切回该组合查看详细处方。</p>}
            {!isDetailedDemo && <button className="restore-demo" onClick={() => { setWindowStart('2025-06-01'); setBudget(3000); setKc(1); }}>查看完整演示处方 <ArrowRight size={14} /></button>}
          </div>
          <div className="prescription-units">
            {prescription.map((item) => <article key={item.id} className={!isDetailedDemo ? 'muted' : ''}>
              <div className="unit-badge" style={{ borderColor: item.accent, color: item.accent }}>{item.id}</div>
              <div><span>{item.name}</span><strong>{isDetailedDemo ? item.supply.toLocaleString() : '—'} <small>m³</small></strong></div>
              <dl><div><dt>阈值下天数</dt><dd>{isDetailedDemo ? `${item.days} 天` : '—'}</dd></div><div><dt>第 7 天 θ</dt><dd>{isDetailedDemo ? item.finalTheta.toFixed(3) : '—'}</dd></div></dl>
            </article>)}
          </div>
          <div className="prescription-footer"><CloudRain size={14} />气象驱动：Open-Meteo ERA5 日降水 + FAO ET₀ · 当前一次补水后模拟未来 7 天</div>
        </div>
      </section>

      <div id="map-import"><ImageryWorkspace onStatisticsImported={setImageryStatus} onImageLayersChange={setImageLayers} /></div>

      <section id="evidence" className="evidence-section">
        <div className="section-heading light"><div><span className="kicker">PROJECT EVIDENCE</span><h2>申报书内容如何落到网站里</h2><p>每个页面模块都对应已有材料、可复现数据或明确的下一步任务。</p></div></div>
        <div className="evidence-flow">
          <Evidence number="01" title="公开数据监测" body="ERA5 30 天气象已准备；GEE 脚本已包含 Sentinel-2 与 Dynamic World 工作流。" status="气象已接入 / 遥感待运行" />
          <Evidence number="02" title="缺水风险诊断" body="以根区水量平衡和低于临界储水量的面积加权累计亏缺作为风险代理。" status="模型原型已实现" />
          <Evidence number="03" title="有限水量优化" body="四种策略、72 个情景、288 条结果，支持窗口、预算和 Kc 交互对照。" status="实验矩阵已接入" />
          <Evidence number="04" title="处方与评估" body="输出单元水量、7 天轨迹、阈值下天数与剩余水量，保留参数来源与限制。" status="演示处方已接入" />
        </div>
        <div className="limits-row">
          <div><AlertTriangle size={18} /><span><b>尚待完成</b>GEE 云端运行记录、H1/H2 人工判读、现场参数校准与供水连通性核查。</span></div>
          <a href="https://code.earthengine.google.com/" target="_blank" rel="noreferrer">打开 Earth Engine <ExternalLink size={14} /></a>
        </div>
      </section>

      <footer><div><Droplets size={18} /><span><b>水脉智调</b> · 湿地生态补水智能决策系统</span></div><p>技术原型 · 数据与模型边界均在页面中明示 · © 2026 水脉智调团队</p></footer>
    </main>
  );
}

function PanelTitle({ icon, title, meta }: { icon: React.ReactNode; title: string; meta: string }) {
  return <div className="panel-title"><span>{icon}{title}</span><small>{meta}</small></div>;
}

function Control({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return <div className="control"><label>{label}<small>{hint}</small></label>{children}</div>;
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div><span>{icon}{label}</span><b>{value}</b></div>;
}

function Evidence({ number, title, body, status }: { number: string; title: string; body: string; status: string }) {
  return <article><span>{number}</span><h3>{title}</h3><p>{body}</p><strong><CheckCircle2 size={13} />{status}</strong></article>;
}
