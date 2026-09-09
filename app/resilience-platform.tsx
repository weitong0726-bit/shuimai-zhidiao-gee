'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import {
  Activity,
  Bot,
  BrainCircuit,
  ChevronRight,
  Database,
  Gauge,
  Layers3,
  MapPin,
  Play,
  Satellite,
  Search,
  ShieldAlert,
  Sparkles,
  UploadCloud,
  Waves,
} from 'lucide-react';

type LayerId =
  | 'four_dim_er'
  | 'four_dim_fri'
  | 'four_dim_erd'
  | 'ndvi'
  | 'ntl'
  | 'water'
  | 'clcd';
type Year = 2000 | 2005 | 2010 | 2015 | 2020 | 2024;

type Feature = {
  properties: {
    Name: string;
    AdminCode: string;
    CityName: string;
    ProName: string;
  };
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  };
};

type RegionRecord = {
  id: string;
  name: string;
  city: string;
  province: string;
  stats: Record<
    string,
    Record<
      string,
      { mean: number; median: number; p90: number; min: number; max: number }
    >
  >;
  derived: {
    low_resilience_high_risk_ratio: number;
    built_ratio_2024: number;
    water_frequency_ratio_2024: number;
    ndvi_delta_mean: number;
    evi_delta_mean: number;
    ntl_delta_mean: number;
    gdp_delta_mean: number;
  };
};

type RegionData = {
  metadata: {
    thresholds: { fri_high: number; er_low: number; erd_low: number };
  };
  regions: Record<string, RegionRecord>;
};

type GeoJsonData = { features: Feature[] };

type SummaryDatum = {
  available?: boolean;
  mean?: number;
  median?: number;
  p90?: number;
  min?: number;
  max?: number;
  sourceYear?: number;
};

type LayerSummary = {
  timeline: Record<string, Record<string, SummaryDatum>>;
};

const YEARS: Year[] = [2000, 2005, 2010, 2015, 2020, 2024];
const BOUNDS = {
  west: 112.177287,
  south: 34.23536324852,
  east: 116.68009236105,
  north: 36.454202,
};
const SVG_W = 1000;
const SVG_H = 493;

const LAYERS: Record<
  LayerId,
  {
    name: string;
    short: string;
    category: string;
    unit: string;
    description: string;
    legend: string[];
    legendLabels: [string, string];
  }
> = {
  four_dim_er: {
    name: '四维综合生态韧性 ER',
    short: '综合韧性',
    category: '韧性诊断',
    unit: '0—1',
    description:
      '综合规模、密度、形态与洪水韧性的四维生态韧性指数，数值越高表示综合韧性越强。',
    legend: ['#aa3732', '#dc7d42', '#e8ca67', '#70a75d', '#23845c'],
    legendLabels: ['低韧性', '高韧性'],
  },
  four_dim_fri: {
    name: '洪水风险 FRI',
    short: '洪水风险',
    category: '韧性诊断',
    unit: '0—1',
    description:
      '综合相对高程、坡度、水体发生率和土地覆盖风险，数值越高表示洪水风险越高。',
    legend: ['#2f6e98', '#73a4ad', '#efd067', '#e08a49', '#c54b3f'],
    legendLabels: ['低风险', '高风险'],
  },
  four_dim_erd: {
    name: '密度韧性 ERD',
    short: '密度韧性',
    category: '韧性诊断',
    unit: '0—1',
    description: '生态承载能力相对人口、GDP 与夜间灯光压力的韧性表现。',
    legend: ['#aa3732', '#d8844e', '#e6c867', '#69a46b', '#257e68'],
    legendLabels: ['承载弱', '承载强'],
  },
  ndvi: {
    name: '归一化植被指数 NDVI',
    short: 'NDVI',
    category: '生态本底',
    unit: '',
    description:
      '植被覆盖与生态质量的核心遥感指标，用于识别植被状态及长期变化。',
    legend: ['#f4edc6', '#d7d89d', '#a9bd72', '#719b56', '#397843'],
    legendLabels: ['低覆盖', '高覆盖'],
  },
  water: {
    name: 'JRC 水体分类',
    short: '水体',
    category: '生态本底',
    unit: '类别',
    description:
      '用于识别季节性水体、永久水体与洪泛背景，源数据最新有效年份为 2021。',
    legend: ['#d8e6eb', '#8fc1d8', '#3685b3', '#075786'],
    legendLabels: ['非水体', '永久水体'],
  },
  clcd: {
    name: 'CLCD 土地覆盖',
    short: '土地覆盖',
    category: '人类活动',
    unit: '类别',
    description: '识别耕地、林地、草地、水体、建设用地等类型及其时序变化。',
    legend: ['#eedf75', '#3d8a4f', '#9dc46b', '#287eaf', '#d85b36'],
    legendLabels: ['生态空间', '建设用地'],
  },
  ntl: {
    name: '夜间灯光 NTL',
    short: '夜间灯光',
    category: '人类活动',
    unit: '',
    description:
      '近似表征人类活动强度与建设开发压力，用于密度韧性和适应力分析。',
    legend: ['#15192e', '#34446d', '#756f80', '#d18b5d', '#ffd06a'],
    legendLabels: ['低强度', '高强度'],
  },
};

const FEATURED_REGIONS = ['410926', '410927', '370832', '371726', '371725'];

function project([lon, lat]: number[]) {
  return [
    ((lon - BOUNDS.west) / (BOUNDS.east - BOUNDS.west)) * SVG_W,
    ((BOUNDS.north - lat) / (BOUNDS.north - BOUNDS.south)) * SVG_H,
  ];
}

function ringPath(ring: number[][]) {
  return (
    ring
      .map((coordinate, index) => {
        const [x, y] = project(coordinate);
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ') + ' Z'
  );
}

function featurePath(feature: Feature) {
  if (feature.geometry.type === 'Polygon') {
    return (feature.geometry.coordinates as number[][][])
      .map(ringPath)
      .join(' ');
  }
  return (feature.geometry.coordinates as number[][][][])
    .flatMap((polygon) => polygon.map(ringPath))
    .join(' ');
}

function statValue(data?: SummaryDatum) {
  if (!data || data.available === false) return null;
  return data.mean ?? data.median ?? null;
}

function formatMetric(
  value: number | null | undefined,
  layer: LayerId,
  digits = 3,
) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (layer === 'ntl') return value.toFixed(2);
  if (layer === 'clcd' || layer === 'water') return value.toFixed(1);
  return value.toFixed(digits);
}

function changeLabel(value: number | null, layer: LayerId) {
  if (value === null) return '暂无可比数据';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatMetric(value, layer, layer === 'ntl' ? 2 : 3)}`;
}

export function ResiliencePlatform() {
  const [activeLayer, setActiveLayer] = useState<LayerId>('four_dim_er');
  const [year, setYear] = useState<Year>(2024);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [regions, setRegions] = useState<RegionData | null>(null);
  const [summary, setSummary] = useState<LayerSummary | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState('410926');
  const [showBoundaries, setShowBoundaries] = useState(true);
  const [opacity, setOpacity] = useState(94);
  const [agentMode, setAgentMode] = useState<
    'diagnose' | 'compare' | 'action' | 'evidence'
  >('diagnose');
  const [question, setQuestion] = useState('');
  const [assetId, setAssetId] = useState(
    'users/your_account/yellow_river_floodplain',
  );
  const [ingestMessage, setIngestMessage] = useState('');
  const [localFile, setLocalFile] = useState('尚未载入本地结果');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([
      fetch('/project-data/region-boundaries.geojson').then(
        (response) => response.json() as Promise<GeoJsonData>,
      ),
      fetch('/project-data/region-analysis.json').then(
        (response) => response.json() as Promise<RegionData>,
      ),
      fetch('/project-data/layer-summary.json').then(
        (response) => response.json() as Promise<LayerSummary>,
      ),
    ])
      .then(([geojson, regionData, layerData]) => {
        setFeatures(geojson.features ?? []);
        setRegions(regionData);
        setSummary(layerData);
      })
      .catch(() => undefined);
  }, []);

  const selectedRegion = regions?.regions[selectedRegionId];
  const activeMeta = LAYERS[activeLayer];
  const currentSummary = summary?.timeline[String(year)]?.[activeLayer];
  const firstSummary = summary?.timeline['2000']?.[activeLayer];
  const globalValue = statValue(currentSummary);
  const globalDelta =
    globalValue !== null && statValue(firstSummary) !== null
      ? globalValue - (statValue(firstSummary) as number)
      : null;
  const timeline = useMemo(
    () =>
      YEARS.map((item) => ({
        year: item,
        value: statValue(summary?.timeline[String(item)]?.[activeLayer]),
      })).filter(
        (item): item is { year: Year; value: number } => item.value !== null,
      ),
    [summary, activeLayer],
  );

  const selectedFeature = features.find(
    (feature) => feature.properties.AdminCode === selectedRegionId,
  );
  const imageUrl = `/project-data/overlays/${activeLayer}/${year}.png`;
  const regionLayerKey = activeLayer;
  const regionYear = year === 2020 ? '2020' : '2024';
  const regionStat = selectedRegion?.stats?.[regionLayerKey]?.[regionYear];

  const agentAnswer = useMemo(() => {
    if (!selectedRegion) return '正在读取 28 个县域的统计数据与阈值……';
    const stats = selectedRegion.stats;
    const er = stats.four_dim_er?.['2024']?.median;
    const fri = stats.four_dim_fri?.['2024']?.median;
    const erd = stats.four_dim_erd?.['2024']?.median;
    const overlap = selectedRegion.derived.low_resilience_high_risk_ratio * 100;
    const ndvi = selectedRegion.derived.ndvi_delta_mean;
    const ntl = selectedRegion.derived.ntl_delta_mean;
    if (agentMode === 'compare') {
      const er2020 = stats.four_dim_er?.['2020']?.median;
      const fri2020 = stats.four_dim_fri?.['2020']?.median;
      return `${selectedRegion.name} 2020→2024：综合韧性中位数由 ${er2020?.toFixed(3)} 变为 ${er?.toFixed(3)}（${er && er2020 ? (er - er2020 >= 0 ? '+' : '') + (er - er2020).toFixed(3) : '—'}）；洪水风险由 ${fri2020?.toFixed(3)} 变为 ${fri?.toFixed(3)}。同期 NDVI 均值变化 ${ndvi >= 0 ? '+' : ''}${ndvi.toFixed(3)}，夜间灯光均值变化 ${ntl >= 0 ? '+' : ''}${ntl.toFixed(2)}。`;
    }
    if (agentMode === 'action') {
      const priority =
        overlap >= 30 ? '优先级 I' : overlap >= 15 ? '优先级 II' : '常规监测';
      return `${selectedRegion.name}建议列为“${priority}”。先在高 FRI—低 ER 重叠网格开展河道连通与低洼点核验；对 NDVI 下降区布设植被恢复样方；对夜间灯光增幅较高区域复核建设扰动。治理前后统一使用 250 m 网格复算 ER、ERD 与 FRI，形成可量化验收闭环。`;
    }
    if (agentMode === 'evidence') {
      return `证据链：县域边界来自 region_boundaries.geojson；统计来自 2020/2024 查询网格；当前 ${selectedRegion.name}样本显示 FRI 中位数 ${fri?.toFixed(3)}、ER 中位数 ${er?.toFixed(3)}、ERD 中位数 ${erd?.toFixed(3)}，高风险—低韧性像元重叠 ${overlap.toFixed(1)}%。注意：当前边界由栅格有效区反推，严格面积计算需转等面积投影。`;
    }
    return `${selectedRegion.name}的主要信号是：2024 年 FRI 中位数 ${fri?.toFixed(3)}，综合 ER 中位数 ${er?.toFixed(3)}，密度韧性 ERD 中位数 ${erd?.toFixed(3)}；高风险与低韧性像元重叠 ${overlap.toFixed(1)}%。${ndvi < 0 ? '植被指数呈下降，应优先核查退化斑块。' : '植被指数未见整体下降。'}${ntl > 0.5 ? '人类活动压力增幅较明显。' : '人类活动压力变化相对有限。'}`;
  }, [selectedRegion, agentMode]);

  const visibleFeatures = useMemo(
    () =>
      features.map((feature) => ({
        feature,
        path: featurePath(feature),
      })),
    [features],
  );

  function chooseLayer(layer: LayerId) {
    setActiveLayer(layer);
    if (!YEARS.includes(year)) setYear(2024);
  }

  function handleFile(file?: File) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (typeof reader.result !== 'string')
          throw new Error('读取结果不是文本');
        const parsed = JSON.parse(reader.result);
        const count = Array.isArray(parsed.features)
          ? parsed.features.length
          : Object.keys(parsed).length;
        setLocalFile(`${file.name} · 已在浏览器载入 ${count} 个对象（未上传）`);
      } catch {
        setLocalFile(`${file.name} · 无法解析，请使用 JSON / GeoJSON`);
      }
    };
    reader.readAsText(file);
  }

  return (
    <main className="platform-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">
            <Waves size={20} />
          </span>
          <span>
            <strong>河韧智镜</strong>
            <small>YELLOW RIVER RESILIENCE TWIN</small>
          </span>
        </div>
        <nav className="topnav" aria-label="主导航">
          <a href="#workspace">数字孪生</a>
          <a href="#analysis">区域诊断</a>
          <a href="#agent">韧性智能体</a>
          <a href="#data-access">数据接入</a>
        </nav>
        <div className="top-status">
          <span className="live-dot" /> 数据产品已加载 <b>50 / 50</b>
        </div>
      </header>

      <section className="intro-strip">
        <div>
          <span className="eyebrow">黄河滩区中下游 · 河南—山东研究区</span>
          <h1>遥感数字孪生 × 生态韧性智能体</h1>
          <p>
            把多源遥感、社会经济和洪水风险压到同一 250 m
            网格，让“哪里脆弱、为什么脆弱、先治理哪里”可以被查询、比较和复核。
          </p>
        </div>
        <div className="intro-metrics">
          <MetricCompact label="研究范围" value="112.18°—116.68°E" />
          <MetricCompact label="统一网格" value="2005 × 988" />
          <MetricCompact label="县域单元" value="28 个" />
          <MetricCompact label="时间跨度" value="2000—2024" />
        </div>
      </section>

      <section id="workspace" className="workspace">
        <aside className="layer-panel panel">
          <div className="panel-heading">
            <span>
              <Layers3 size={16} /> 专题图层
            </span>
            <small>7 个已发布图层</small>
          </div>
          {(['韧性诊断', '生态本底', '人类活动'] as const).map((category) => (
            <div className="layer-group" key={category}>
              <div className="layer-group-title">{category}</div>
              {(Object.keys(LAYERS) as LayerId[])
                .filter((id) => LAYERS[id].category === category)
                .map((id) => (
                  <button
                    key={id}
                    className={`layer-button ${activeLayer === id ? 'active' : ''}`}
                    onClick={() => chooseLayer(id)}
                  >
                    <span
                      className="layer-symbol"
                      style={{
                        background:
                          LAYERS[id].legend[LAYERS[id].legend.length - 1],
                      }}
                    />
                    <span>
                      <strong>{LAYERS[id].short}</strong>
                      <small>{LAYERS[id].name}</small>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                ))}
            </div>
          ))}
          <div className="layer-controls">
            <label>
              <span>影像透明度</span>
              <b>{opacity}%</b>
            </label>
            <input
              type="range"
              min="35"
              max="100"
              value={opacity}
              onChange={(event) => setOpacity(Number(event.target.value))}
            />
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={showBoundaries}
                onChange={(event) => setShowBoundaries(event.target.checked)}
              />
              <span>显示县域边界</span>
            </label>
          </div>
        </aside>

        <div className="map-stage panel">
          <div className="map-toolbar">
            <div>
              <span className="crumb">数字孪生 / {activeMeta.category}</span>
              <strong>{activeMeta.name}</strong>
            </div>
            <div className="year-switcher" aria-label="年份切换">
              {YEARS.map((item) => (
                <button
                  key={item}
                  className={year === item ? 'active' : ''}
                  onClick={() => setYear(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
          <div className="map-canvas">
            <Image
              src={imageUrl}
              alt={`${year}年${activeMeta.name}专题影像`}
              fill
              unoptimized
              style={{ opacity: opacity / 100 }}
            />
            {showBoundaries && (
              <svg
                className="boundary-layer"
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                preserveAspectRatio="none"
                aria-label="县域选择图层"
              >
                {visibleFeatures.map(({ feature, path }) => {
                  const id = feature.properties.AdminCode;
                  return (
                    <path
                      key={id}
                      d={path}
                      className={selectedRegionId === id ? 'selected' : ''}
                      onClick={() => setSelectedRegionId(id)}
                    >
                      <title>{feature.properties.Name}</title>
                    </path>
                  );
                })}
              </svg>
            )}
            <div className="map-label west">洛阳</div>
            <div className="map-label middle">郑州</div>
            <div className="map-label east">濮阳</div>
            <div className="map-north">
              N<br />
              <span>↑</span>
            </div>
            <div className="map-scale">0　25　50 km</div>
            <div className="map-tip">
              <MapPin size={14} /> 点击县域查看统计
            </div>
          </div>
          <div className="map-footer">
            <div className="legend">
              <span>{activeMeta.legendLabels[0]}</span>
              <i
                style={{
                  background: `linear-gradient(90deg, ${activeMeta.legend.join(',')})`,
                }}
              />
              <span>{activeMeta.legendLabels[1]}</span>
            </div>
            <span>EPSG:4326 · 0.00224578821° · 约 250 m</span>
            <span>源年份 {currentSummary?.sourceYear ?? year}</span>
          </div>
        </div>

        <aside className="insight-panel panel">
          <div className="panel-heading">
            <span>
              <Gauge size={16} /> 孪生状态
            </span>
            <small>{year} 年</small>
          </div>
          <div className="global-score">
            <span>
              研究区{activeMeta.short}
              {activeMeta.unit && `（${activeMeta.unit}）`}
            </span>
            <strong>{formatMetric(globalValue, activeLayer)}</strong>
            <small>
              相较 2000 年{' '}
              <b
                className={
                  globalDelta !== null && globalDelta < 0 ? 'negative' : ''
                }
              >
                {changeLabel(globalDelta, activeLayer)}
              </b>
            </small>
          </div>
          <p className="layer-description">{activeMeta.description}</p>
          <MiniTrend points={timeline} activeYear={year} />
          <div className="selected-region" id="analysis">
            <div className="selected-title">
              <span>
                <MapPin size={15} /> 当前县域
              </span>
              <small>{regionYear} 区域统计</small>
            </div>
            <h2>
              {selectedRegion?.name ??
                selectedFeature?.properties.Name ??
                '加载中'}
            </h2>
            <p>
              {selectedRegion
                ? `${selectedRegion.province} · ${selectedRegion.city}`
                : '正在匹配县域数据'}
            </p>
            <div className="region-kpis">
              <RegionKpi
                label={activeMeta.short}
                value={formatMetric(regionStat?.median, activeLayer)}
              />
              <RegionKpi
                label="风险—低韧性重叠"
                value={
                  selectedRegion
                    ? `${(selectedRegion.derived.low_resilience_high_risk_ratio * 100).toFixed(1)}%`
                    : '—'
                }
                alert
              />
              <RegionKpi
                label="NDVI 变化"
                value={
                  selectedRegion
                    ? changeLabel(
                        selectedRegion.derived.ndvi_delta_mean,
                        'ndvi',
                      )
                    : '—'
                }
              />
              <RegionKpi
                label="夜光变化"
                value={
                  selectedRegion
                    ? changeLabel(selectedRegion.derived.ntl_delta_mean, 'ntl')
                    : '—'
                }
              />
            </div>
          </div>
          <div className="priority-list">
            <div className="priority-head">
              <span>重点复核县域</span>
              <small>按重叠像元占比</small>
            </div>
            {FEATURED_REGIONS.map((id, index) => {
              const region = regions?.regions[id];
              return (
                <button
                  key={id}
                  onClick={() => setSelectedRegionId(id)}
                  className={selectedRegionId === id ? 'active' : ''}
                >
                  <b>0{index + 1}</b>
                  <span>
                    {region?.name ?? '读取中'}
                    <small>
                      {region
                        ? `${(region.derived.low_resilience_high_risk_ratio * 100).toFixed(1)}%`
                        : '—'}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>
      </section>

      <section id="agent" className="agent-section">
        <div className="section-copy">
          <span className="eyebrow">RESILIENCE AGENT</span>
          <h2>不是聊天装饰，而是把数据转成治理动作</h2>
          <p>
            当前线上演示使用可复核的本地规则引擎；项目 FastAPI
            部署并配置兼容大模型后，可直接替换为流式 Function
            Calling，对接区域查询、趋势计算、地图高亮与报告生成。
          </p>
          <div className="agent-capabilities">
            <span>
              <Search size={15} /> 区域查询
            </span>
            <span>
              <Activity size={15} /> 趋势诊断
            </span>
            <span>
              <BrainCircuit size={15} /> 归因推理
            </span>
            <span>
              <FileDownIcon /> 报告结构
            </span>
          </div>
        </div>
        <div className="agent-console">
          <div className="agent-console-head">
            <span>
              <Bot size={18} /> 韧性智能体
            </span>
            <small>
              <i /> 本地规则引擎已启用
            </small>
          </div>
          <div className="prompt-row">
            {(
              [
                ['diagnose', '诊断当前县域'],
                ['compare', '对比 2020—2024'],
                ['action', '生成治理建议'],
                ['evidence', '查看证据链'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                className={agentMode === mode ? 'active' : ''}
                onClick={() => setAgentMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="agent-answer">
            <span className="agent-avatar">
              <Sparkles size={16} />
            </span>
            <div>
              <b>{selectedRegion?.name ?? '县域'} · 分析结果</b>
              <p>{agentAnswer}</p>
            </div>
          </div>
          <form
            className="agent-input"
            onSubmit={(event) => {
              event.preventDefault();
              const text = question;
              if (/治理|建议|怎么做/.test(text)) setAgentMode('action');
              else if (/证据|来源|可靠/.test(text)) setAgentMode('evidence');
              else if (/变化|对比|趋势/.test(text)) setAgentMode('compare');
              else setAgentMode('diagnose');
              setQuestion('');
            }}
          >
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={`继续追问 ${selectedRegion?.name ?? '当前县域'} 的风险、变化或治理建议`}
            />
            <button type="submit">
              <Play size={14} fill="currentColor" /> 分析
            </button>
          </form>
        </div>
      </section>

      <section id="data-access" className="data-section">
        <div className="data-heading">
          <div>
            <span className="eyebrow">DATA PIPELINE</span>
            <h2>影像导入与分析数据链路</h2>
          </div>
          <p>
            统一投影、范围、分辨率与重采样规则，网站读取的是已经质检通过的真实结果，而不是占位图。
          </p>
        </div>
        <div className="pipeline-grid">
          <div className="pipeline-card">
            <span className="card-icon">
              <Satellite size={20} />
            </span>
            <h3>GEE 资产接入任务</h3>
            <p>
              输入研究区 Asset
              ID，生成与现有处理标准一致的接入任务参数。线上站不会保存 GEE
              凭据。
            </p>
            <label htmlFor="gee-asset-id">Earth Engine Asset ID</label>
            <input
              id="gee-asset-id"
              value={assetId}
              onChange={(event) => setAssetId(event.target.value)}
            />
            <button
              onClick={() =>
                setIngestMessage(
                  `任务已生成：${assetId} → EPSG:4326 / 250 m / 研究区 bbox。部署后端 OAuth 服务后即可提交到 GEE。`,
                )
              }
            >
              <UploadCloud size={15} /> 生成接入任务
            </button>
            {ingestMessage && (
              <div className="task-message">{ingestMessage}</div>
            )}
          </div>
          <div className="pipeline-card">
            <span className="card-icon">
              <Database size={20} />
            </span>
            <h3>导入离线分析结果</h3>
            <p>
              支持在浏览器中校验 JSON / GeoJSON，可用于赛场演示边界、统计摘要或
              GEE 导出清单。
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".json,.geojson,application/json"
              hidden
              onChange={(event) => handleFile(event.target.files?.[0])}
            />
            <button
              className="secondary"
              onClick={() => fileInput.current?.click()}
            >
              <Database size={15} /> 选择结果文件
            </button>
            <div className="file-status">{localFile}</div>
          </div>
          <div className="pipeline-card standards">
            <span className="card-icon">
              <ShieldAlert size={20} />
            </span>
            <h3>统一处理与可信边界</h3>
            <ul>
              <li>
                <b>坐标系</b>
                <span>EPSG:4326</span>
              </li>
              <li>
                <b>分析网格</b>
                <span>约 250 m</span>
              </li>
              <li>
                <b>分类数据</b>
                <span>nearest</span>
              </li>
              <li>
                <b>连续变量</b>
                <span>bilinear</span>
              </li>
              <li>
                <b>质量检查</b>
                <span>50 / 50 通过</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="delivery-section">
        <div>
          <span className="eyebrow">COMPETITION DELIVERY</span>
          <h2>答辩时按一条闭环演示</h2>
        </div>
        <div className="delivery-flow">
          <DeliveryStep
            number="01"
            title="选图层与年份"
            text="切换 ER、FRI、NDVI 等真实影像"
          />
          <DeliveryStep
            number="02"
            title="点击重点县域"
            text="查看 2020 / 2024 统计与风险重叠"
          />
          <DeliveryStep
            number="03"
            title="调用智能诊断"
            text="得到归因、证据与治理优先级"
          />
          <DeliveryStep
            number="04"
            title="导入增量数据"
            text="用 GEE 或本地结果更新分析链"
          />
        </div>
      </section>

      <footer>
        <div className="brand-lockup">
          <span className="brand-mark">
            <Waves size={18} />
          </span>
          <span>
            <strong>河韧智镜</strong>
            <small>黄河滩区生态韧性数智平台</small>
          </span>
        </div>
        <p>数据范围：112.177287°E—116.680092°E / 34.235363°N—36.454202°N</p>
        <p>研究原型 · 不替代工程调度与行政决策</p>
      </footer>
    </main>
  );
}

function MetricCompact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function RegionKpi({
  label,
  value,
  alert = false,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div className={alert ? 'alert' : ''}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function MiniTrend({
  points,
  activeYear,
}: {
  points: { year: Year; value: number }[];
  activeYear: Year;
}) {
  if (points.length < 2)
    return <div className="trend-empty">该图层暂无完整时序</div>;
  const width = 260;
  const height = 84;
  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const range = Math.max(max - min, 0.001);
  const plotted = points.map((point, index) => ({
    ...point,
    x: 8 + (index / (points.length - 1)) * (width - 16),
    y: 10 + ((max - point.value) / range) * (height - 28),
  }));
  const path = plotted
    .map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`)
    .join(' ');
  return (
    <div className="trend-card">
      <div className="trend-title">
        <span>研究区时序</span>
        <small>
          {points[0].year}—{points[points.length - 1].year}
        </small>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`}>
        <path
          className="trend-area"
          d={`${path} L${plotted[plotted.length - 1].x},${height - 12} L${plotted[0].x},${height - 12} Z`}
        />
        <path className="trend-line" d={path} />
        {plotted.map((point) => (
          <circle
            key={point.year}
            cx={point.x}
            cy={point.y}
            r={point.year === activeYear ? 4 : 2.5}
            className={point.year === activeYear ? 'active' : ''}
          >
            <title>
              {point.year}: {point.value.toFixed(4)}
            </title>
          </circle>
        ))}
      </svg>
      <div className="trend-years">
        {points.map((point) => (
          <span key={point.year}>{String(point.year).slice(2)}</span>
        ))}
      </div>
    </div>
  );
}

function DeliveryStep({
  number,
  title,
  text,
}: {
  number: string;
  title: string;
  text: string;
}) {
  return (
    <div>
      <b>{number}</b>
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
      <ChevronRight size={17} />
    </div>
  );
}

function FileDownIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M12 18v-6m-3 3 3 3 3-3" />
    </svg>
  );
}
