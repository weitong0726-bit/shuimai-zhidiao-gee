'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  CheckCircle2,
  Download,
  Droplets,
  Gauge,
  Leaf,
  SlidersHorizontal,
  Sparkles,
  Waves,
} from 'lucide-react';

export type GeeUnitMetric = {
  id: string;
  name: string;
  areaM2: number | null;
  validFraction: number | null;
  waterAreaM2: number | null;
  ndvi: number | null;
  ndmi: number | null;
  mndwi: number | null;
};
export type GeeEvidence = {
  start: string;
  end: string;
  sceneCount: number;
  mean: number | null;
  unitMetrics: GeeUnitMetric[];
  projectId?: string;
};
export type DecisionUnit = {
  id: string;
  name: string;
  areaM2: number;
  stressScore: number;
  riskAfter: number;
  supplyM3: number;
  effectiveDepthMm: number;
  ndmi: number | null;
  validFraction: number | null;
};
export type DecisionPlan = {
  strategy: string;
  budgetM3: number;
  usedM3: number;
  riskBefore: number;
  riskAfter: number;
  improvement: number;
  source: 'gee' | 'scenario';
  units: DecisionUnit[];
};

type UnitResult = {
  id: string;
  name: string;
  supply_m3: number;
  loss: number;
  days_below_threshold: number;
};
type StrategyResult = {
  used_m3: number;
  unused_m3: number;
  loss: number;
  units: UnitResult[];
};
type DemoData = {
  start: string;
  end: string;
  budget_m3: number;
  strategies: Record<string, StrategyResult>;
};

const STRATEGIES = [
  {
    key: '七天缺水指标优化',
    label: '风险敏感优化',
    description: '优先保护遥感水分风险高、边际收益大的单元',
    accent: true,
  },
  {
    key: '初始缺水量比例',
    label: '按水分亏缺',
    description: '按单元水分压力与面积乘积分配',
    accent: false,
  },
  {
    key: '面积比例',
    label: '按面积分配',
    description: '作为简单、透明的工程基准方案',
    accent: false,
  },
  {
    key: '不补水',
    label: '不补水基线',
    description: '表示不采取行动时的对照风险',
    accent: false,
  },
] as const;
const BUDGET_PRESETS = [1000, 3000, 5000, 10000, 30000];

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}
function formatM3(value: number) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(
    Math.max(0, value),
  );
}
function allocateExact(total: number, weights: number[]) {
  if (total <= 0 || weights.length === 0) return weights.map(() => 0);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const rounded = weights.map((weight) =>
    Math.round((total * weight) / Math.max(weightTotal, 1)),
  );
  const allocatedBeforeLast = rounded
    .slice(0, -1)
    .reduce((sum, value) => sum + value, 0);
  return rounded.map((value, index) =>
    index === rounded.length - 1
      ? Math.max(0, total - allocatedBeforeLast)
      : value,
  );
}
function scoreMetric(metric: GeeUnitMetric) {
  const ndmiDeficit = clamp((0.2 - (metric.ndmi ?? 0.2)) / 0.7);
  const surfaceWaterDeficit = clamp((0 - (metric.mndwi ?? 0)) / 0.65);
  const vegetationWeakness = clamp((0.4 - (metric.ndvi ?? 0.4)) / 0.7);
  return (
    clamp(
      0.55 * ndmiDeficit +
        0.25 * surfaceWaterDeficit +
        0.2 * vegetationWeakness,
    ) * 100
  );
}

function downloadPlan(plan: DecisionPlan, evidence?: GeeEvidence | null) {
  const header = [
    '单元ID',
    '生态单元',
    '面积_m2',
    '遥感压力分',
    '建议水量_m3',
    '有效水深_mm',
    '方案后风险分',
    'NDMI',
    '有效覆盖率',
    '分配策略',
    '诊断开始',
    '诊断结束',
  ];
  const rows = plan.units.map((unit) => [
    unit.id,
    unit.name,
    Math.round(unit.areaM2),
    unit.stressScore.toFixed(1),
    unit.supplyM3,
    unit.effectiveDepthMm.toFixed(2),
    unit.riskAfter.toFixed(1),
    unit.ndmi?.toFixed(4) ?? '',
    unit.validFraction === null
      ? ''
      : `${(unit.validFraction * 100).toFixed(1)}%`,
    plan.strategy,
    evidence?.start || '',
    evidence?.end || '',
  ]);
  const csv = `\uFEFF${header.join(',')}\n${rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')}`;
  const url = URL.createObjectURL(
    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `shuimai-plan-${plan.budgetM3}m3.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function WaterDecisionPanel({
  evidence,
  fallbackAreaKm2 = 3,
  onPlanChange,
}: {
  evidence?: GeeEvidence | null;
  fallbackAreaKm2?: number;
  onPlanChange?: (plan: DecisionPlan | null) => void;
}) {
  const [demo, setDemo] = useState<DemoData | null>(null);
  const [budget, setBudget] = useState(3000);
  const [strategy, setStrategy] = useState('七天缺水指标优化');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/wetland-data/demo.json')
      .then((response) => response.json() as Promise<DemoData>)
      .then((demoData) => {
        if (active) setDemo(demoData);
      })
      .catch(() => {
        if (active) setLoadError('补水情景数据暂时无法读取。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const plan = useMemo<DecisionPlan | null>(() => {
    if (evidence?.unitMetrics.length) {
      const prepared = evidence.unitMetrics.map((metric) => ({
        metric,
        areaM2:
          metric.areaM2 ||
          (fallbackAreaKm2 * 1_000_000) / evidence.unitMetrics.length,
        stress: scoreMetric(metric),
      }));
      const weights = prepared.map(({ areaM2, stress }) => {
        if (strategy === '不补水') return 0;
        if (strategy === '面积比例') return areaM2;
        if (strategy === '初始缺水量比例') return areaM2 * Math.max(stress, 1);
        return Math.sqrt(areaM2) * Math.max(stress, 1) ** 1.7;
      });
      const usedM3 = strategy === '不补水' ? 0 : budget;
      const supplies = allocateExact(usedM3, weights);
      const units = prepared.map(({ metric, areaM2, stress }, index) => {
        const supplyM3 = supplies[index];
        const effectiveDepthMm = ((supplyM3 * 0.8) / areaM2) * 1000;
        const response = Math.min(
          0.65,
          (1 - Math.exp(-effectiveDepthMm / 18)) *
            (strategy === '七天缺水指标优化' ? 1.08 : 1),
        );
        return {
          id: metric.id,
          name: metric.name,
          areaM2,
          stressScore: stress,
          riskAfter: stress * (1 - response),
          supplyM3,
          effectiveDepthMm,
          ndmi: metric.ndmi,
          validFraction: metric.validFraction,
        };
      });
      const areaTotal = units.reduce((sum, unit) => sum + unit.areaM2, 0);
      const riskBefore =
        units.reduce((sum, unit) => sum + unit.stressScore * unit.areaM2, 0) /
        Math.max(areaTotal, 1);
      const riskAfter =
        units.reduce((sum, unit) => sum + unit.riskAfter * unit.areaM2, 0) /
        Math.max(areaTotal, 1);
      return {
        strategy,
        budgetM3: budget,
        usedM3,
        riskBefore,
        riskAfter,
        improvement:
          riskBefore > 0 ? clamp((riskBefore - riskAfter) / riskBefore) : 0,
        source: 'gee',
        units,
      };
    }
    if (!demo) return null;
    const sourceUnits = demo.strategies['不补水'].units;
    const usedM3 = strategy === '不补水' ? 0 : budget;
    const maxLoss = Math.max(...sourceUnits.map((unit) => unit.loss), 1);
    const prepared = sourceUnits.map((unit) => ({
      unit,
      areaM2: (fallbackAreaKm2 * 1_000_000) / sourceUnits.length,
      stress: clamp(unit.loss / maxLoss) * 100,
    }));
    const weights = prepared.map(({ areaM2, stress }) => {
      if (strategy === '不补水') return 0;
      if (strategy === '面积比例') return areaM2;
      if (strategy === '初始缺水量比例') return areaM2 * Math.max(stress, 1);
      return Math.sqrt(areaM2) * Math.max(stress, 1) ** 1.7;
    });
    const supplies = allocateExact(usedM3, weights);
    const units = prepared.map(({ unit, areaM2, stress }, index) => {
      const supplyM3 = supplies[index];
      const effectiveDepthMm = ((supplyM3 * 0.8) / areaM2) * 1000;
      const response = Math.min(
        0.65,
        (1 - Math.exp(-effectiveDepthMm / 18)) *
          (strategy === '七天缺水指标优化' ? 1.08 : 1),
      );
      return {
        id: unit.id,
        name: unit.name,
        areaM2,
        stressScore: stress,
        riskAfter: stress * (1 - response),
        supplyM3,
        effectiveDepthMm,
        ndmi: null,
        validFraction: null,
      };
    });
    const areaTotal = units.reduce((sum, unit) => sum + unit.areaM2, 0);
    const riskBefore =
      units.reduce((sum, unit) => sum + unit.stressScore * unit.areaM2, 0) /
      Math.max(areaTotal, 1);
    const riskAfter =
      units.reduce((sum, unit) => sum + unit.riskAfter * unit.areaM2, 0) /
      Math.max(areaTotal, 1);
    return {
      strategy,
      budgetM3: budget,
      usedM3,
      riskBefore,
      riskAfter,
      improvement:
        riskBefore > 0 ? clamp((riskBefore - riskAfter) / riskBefore) : 0,
      source: 'scenario',
      units,
    };
  }, [budget, demo, evidence, fallbackAreaKm2, strategy]);
  useEffect(() => {
    onPlanChange?.(plan);
  }, [onPlanChange, plan]);

  return (
    <section
      id="water-decision"
      className="mt-6 overflow-hidden border border-[#b8c5c1] bg-white shadow-[0_18px_50px_rgba(12,44,47,.08)]"
    >
      <div className="grid border-b border-[#d5dedb] bg-[#f5f8f7] lg:grid-cols-[1fr_auto]">
        <div className="px-6 py-5 lg:px-8">
          <div className="eyebrow">
            <span>03</span> SCENARIO OPTIMIZATION
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[#102f31]">
            生态补水处方
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-[#536965]">
            将遥感水分压力、单元面积与有限水量合成一份可解释、可导出的单元级处方。
          </p>
        </div>
        <div
          className={`flex items-center gap-2 border-t px-6 py-4 text-sm font-semibold lg:border-l lg:border-t-0 ${plan?.source === 'gee' ? 'border-[#b9d8cf] bg-[#e8f6f1] text-[#11614f]' : 'border-[#e1d6b7] bg-[#fff9e9] text-[#7a5c17]'}`}
        >
          {plan?.source === 'gee' ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <AlertTriangle className="size-4" />
          )}
          {plan?.source === 'gee' ? '真实GEE诊断驱动' : '内置情景演示'}
        </div>
      </div>
      <div className="p-6 lg:p-8">
        {loading && (
          <div className="grid min-h-48 place-items-center border border-dashed border-[#b7c3bf] bg-[#f7faf9] text-sm text-[#61736f]">
            正在读取补水情景…
          </div>
        )}
        {!loading && loadError && (
          <div className="border border-[#e0b3a8] bg-[#fff2ee] p-4 text-sm text-[#803426]">
            {loadError}
          </div>
        )}
        {!loading && !loadError && plan && (
          <>
            <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
              <div className="border border-[#c6d0cd] bg-[#f5f8f7] p-5">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center bg-[#123d3e] text-[#73e0bf]">
                    <SlidersHorizontal className="size-5" />
                  </span>
                  <div>
                    <p className="text-xs text-[#6a7b77]">约束条件</p>
                    <h3 className="font-semibold text-[#173638]">
                      可用生态水量
                    </h3>
                  </div>
                </div>
                <div className="mt-5 flex items-end gap-2 border-b border-[#aebcb8] pb-2">
                  <input
                    aria-label="可用生态水量"
                    type="number"
                    min="0"
                    max="200000"
                    step="500"
                    value={budget}
                    onChange={(event) =>
                      setBudget(Math.max(0, Number(event.target.value) || 0))
                    }
                    className="min-w-0 flex-1 bg-transparent font-mono text-3xl font-semibold text-[#102f31] outline-none"
                  />
                  <span className="pb-1 text-sm text-[#60726e]">m³</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {BUDGET_PRESETS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setBudget(value)}
                      className={`border px-2.5 py-1 text-xs ${budget === value ? 'border-[#14745f] bg-[#14745f] text-white' : 'border-[#bdc9c5] bg-white text-[#536763] hover:border-[#14745f]'}`}
                    >
                      {formatM3(value)}
                    </button>
                  ))}
                </div>
                <div className="mt-6 text-sm font-semibold text-[#304b48]">
                  分配策略
                </div>
                <div className="mt-2 space-y-2">
                  {STRATEGIES.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setStrategy(item.key)}
                      className={`w-full border px-3 py-3 text-left transition ${strategy === item.key ? 'border-[#13715d] bg-white shadow-[inset_3px_0_0_#36bd98]' : 'border-transparent hover:border-[#bdc9c5] hover:bg-white'}`}
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold text-[#173638]">
                        {item.accent && (
                          <Sparkles className="size-4 text-[#c38e25]" />
                        )}
                        {item.label}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-[#667874]">
                        {item.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="grid gap-px overflow-hidden border border-[#c6d0cd] bg-[#c6d0cd] sm:grid-cols-3">
                  <Metric
                    icon={<Droplets className="size-4" />}
                    label="已分配水量"
                    value={`${formatM3(plan.usedM3)} m³`}
                    detail={
                      plan.usedM3 ? '按单元优先级完成分配' : '作为无干预对照'
                    }
                  />
                  <Metric
                    icon={<Gauge className="size-4" />}
                    label="方案后风险"
                    value={plan.riskAfter.toFixed(1)}
                    detail={`基线 ${plan.riskBefore.toFixed(1)} 风险分`}
                  />
                  <Metric
                    icon={<Leaf className="size-4" />}
                    label="预计改善"
                    value={`${(plan.improvement * 100).toFixed(1)}%`}
                    detail="同一诊断窗口下的情景响应"
                  />
                </div>
                <div className="mt-5 border border-[#c6d0cd] bg-white p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[.14em] text-[#6d7d79]">
                        RISK RESPONSE
                      </p>
                      <h3 className="mt-1 text-lg font-semibold text-[#173638]">
                        风险响应对比
                      </h3>
                    </div>
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-[#14705d]">
                      <ArrowDownRight className="size-4" />
                      {(plan.improvement * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-5 space-y-4">
                    <RiskBar
                      label="不补水基线"
                      value={plan.riskBefore}
                      color="#bd6c4c"
                    />
                    <RiskBar
                      label="当前方案"
                      value={plan.riskAfter}
                      color="#2da885"
                    />
                  </div>
                  <p className="mt-4 text-xs leading-5 text-[#71817d]">
                    响应曲线假定输水效率80%、有效水深18
                    mm为响应尺度；用于方案比较，不替代现场调度参数。
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_320px]">
              <div className="overflow-hidden border border-[#c6d0cd] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d7dfdc] px-5 py-4">
                  <div>
                    <p className="text-xs text-[#6a7b77]">决策结果</p>
                    <h3 className="mt-1 text-lg font-semibold text-[#173638]">
                      单元级补水处方
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => downloadPlan(plan, evidence)}
                    className="action-secondary"
                  >
                    <Download className="size-4" />
                    导出 CSV
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] border-collapse text-sm">
                    <thead>
                      <tr className="bg-[#f5f8f7] text-left text-xs text-[#647570]">
                        <th className="px-5 py-3 font-semibold">单元</th>
                        <th className="px-4 py-3 font-semibold">遥感压力</th>
                        <th className="px-4 py-3 font-semibold">NDMI</th>
                        <th className="px-4 py-3 font-semibold">建议水量</th>
                        <th className="px-4 py-3 font-semibold">有效水深</th>
                        <th className="px-5 py-3 font-semibold">方案后风险</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.units.map((unit) => (
                        <tr key={unit.id} className="border-t border-[#e1e7e5]">
                          <td className="px-5 py-4">
                            <span className="font-semibold text-[#173638]">
                              {unit.name}
                            </span>
                            <span className="mt-1 block font-mono text-xs text-[#7a8985]">
                              {unit.id} · {(unit.areaM2 / 1_000_000).toFixed(2)}{' '}
                              km²
                            </span>
                          </td>
                          <td className="px-4 py-4">
                            <span
                              className={`status-pill ${unit.stressScore >= 45 ? 'danger' : unit.stressScore >= 25 ? 'warning' : 'safe'}`}
                            >
                              {unit.stressScore.toFixed(1)}
                            </span>
                          </td>
                          <td className="px-4 py-4 font-mono text-[#315b54]">
                            {unit.ndmi?.toFixed(3) ?? '待诊断'}
                          </td>
                          <td className="px-4 py-4 font-mono font-semibold text-[#9a6b13]">
                            {formatM3(unit.supplyM3)} m³
                          </td>
                          <td className="px-4 py-4 font-mono">
                            {unit.effectiveDepthMm.toFixed(2)} mm
                          </td>
                          <td className="px-5 py-4">
                            <span className="font-mono font-semibold text-[#176e5b]">
                              {unit.riskAfter.toFixed(1)}
                            </span>
                            <span className="mt-2 block h-1.5 w-24 bg-[#e6ecea]">
                              <span
                                className="block h-full bg-[#35b991]"
                                style={{
                                  width: `${clamp(unit.riskAfter / 100) * 100}%`,
                                }}
                              />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <aside className="bg-[#0d3436] p-5 text-white">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center bg-[#d9aa45] text-[#123335]">
                    <Waves className="size-5" />
                  </span>
                  <div>
                    <p className="text-xs text-[#98bbb5]">DECISION TRACE</p>
                    <h3 className="font-semibold">处方证据链</h3>
                  </div>
                </div>
                <ol className="mt-6 space-y-5 text-sm leading-6 text-[#c9ddda]">
                  <li className="flex gap-3">
                    <span className="trace-number">1</span>
                    <p>
                      <b className="text-white">观测：</b>
                      {plan.source === 'gee'
                        ? `${evidence?.sceneCount || 0}景Sentinel-2影像，单元级NDVI/NDMI/MNDWI。`
                        : '历史气象与假设地块参数。'}
                    </p>
                  </li>
                  <li className="flex gap-3">
                    <span className="trace-number">2</span>
                    <p>
                      <b className="text-white">诊断：</b>55% NDMI亏缺 + 25%
                      MNDWI亏缺 + 20% NDVI弱势。
                    </p>
                  </li>
                  <li className="flex gap-3">
                    <span className="trace-number">3</span>
                    <p>
                      <b className="text-white">决策：</b>
                      {
                        STRATEGIES.find((item) => item.key === strategy)
                          ?.description
                      }
                      。
                    </p>
                  </li>
                  <li className="flex gap-3">
                    <span className="trace-number">4</span>
                    <p>
                      <b className="text-white">复核：</b>
                      补水后7—14天重复同指标观测，并与现场水位、土壤水分联合校验。
                    </p>
                  </li>
                </ol>
                <div className="mt-6 border-t border-white/10 pt-4 text-xs leading-5 text-[#99bcb6]">
                  <AlertTriangle className="mr-1 inline size-3.5" />
                  风险分与响应曲线是可解释情景模型，正式应用前必须用实测样点标定。
                </div>
              </aside>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Metric({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="bg-white px-5 py-4">
      <span className="flex items-center gap-2 text-xs font-medium text-[#687975]">
        {icon}
        {label}
      </span>
      <strong className="mt-2 block font-mono text-2xl text-[#153638]">
        {value}
      </strong>
      <span className="mt-1 block text-xs leading-5 text-[#72827e]">
        {detail}
      </span>
    </div>
  );
}
function RiskBar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="grid grid-cols-[92px_1fr_44px] items-center gap-3">
      <span className="text-xs text-[#647570]">{label}</span>
      <span className="h-2 bg-[#e7ecea]">
        <span
          className="block h-full transition-all"
          style={{
            width: `${clamp(value / 100) * 100}%`,
            backgroundColor: color,
          }}
        />
      </span>
      <strong className="text-right font-mono text-sm text-[#173638]">
        {value.toFixed(1)}
      </strong>
    </div>
  );
}
