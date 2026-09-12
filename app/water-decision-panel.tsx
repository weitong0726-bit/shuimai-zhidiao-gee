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
import type { ScreeningScenario } from './screening-scenario-panel';

export type GeeUnitMetric = {
  id: string;
  name: string;
  areaM2: number | null;
  validFraction: number | null;
  waterAreaM2: number | null;
  ndvi: number | null;
  ndmi: number | null;
  mndwi: number | null;
  candidateWetlandAreaM2?: number | null;
  candidateWetlandFraction?: number | null;
  accessibilityScore?: number | null;
  meanHandM?: number | null;
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
  candidateWetlandAreaM2: number;
  stressScore: number;
  riskAfter: number;
  supplyM3: number;
  equivalentDepthMm: number;
  ndmi: number | null;
  validFraction: number | null;
  accessibilityScore: number | null;
};

export type DecisionPlan = {
  strategy: string;
  budgetM3: number;
  requestedM3: number;
  usedM3: number;
  unallocatedM3: number;
  riskBefore: number;
  riskAfter: number;
  improvement: number;
  source: 'gee';
  scenario: ScreeningScenario;
  sensitivity: { improvementLow: number; improvementHigh: number };
  units: DecisionUnit[];
};

const STRATEGIES = [
  {
    key: '优先级综合',
    label: '需求—可达性综合',
    description: '同时考虑水分压力、候选区面积和潜在可达性',
    accent: true,
  },
  {
    key: '水分压力',
    label: '按水分压力',
    description: '按单元湿地候选区面积与水分压力分配',
    accent: false,
  },
  {
    key: '候选区面积',
    label: '按候选区面积',
    description: '作为不考虑空间差异的透明对照',
    accent: false,
  },
  {
    key: '不补水',
    label: '不补水基线',
    description: '表示不施加情景水量时的对照风险',
    accent: false,
  },
] as const;

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
  if (weightTotal <= 0) return weights.map(() => 0);
  const target = Math.max(0, Math.round(total));
  const raw = weights.map((weight) => (target * weight) / weightTotal);
  const allocations = raw.map(Math.floor);
  const remainder = target - allocations.reduce((sum, value) => sum + value, 0);
  const priority = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction);
  for (let index = 0; index < remainder; index += 1) {
    allocations[priority[index % priority.length].index] += 1;
  }
  return allocations;
}

function allocateCappedExact(
  total: number,
  weights: number[],
  capacities: number[],
) {
  if (total <= 0 || !weights.length) return weights.map(() => 0);
  const raw = weights.map(() => 0);
  const active = new Set(weights.map((_, index) => index));
  let remaining = Math.min(
    total,
    capacities.reduce((sum, value) => sum + Math.max(0, value), 0),
  );
  while (remaining > 1e-6 && active.size) {
    const weightTotal = [...active].reduce(
      (sum, index) => sum + Math.max(0, weights[index]),
      0,
    );
    if (weightTotal <= 0) break;
    const saturated = [...active].find((index) => {
      const share = (remaining * Math.max(0, weights[index])) / weightTotal;
      return share > capacities[index] - raw[index] + 1e-6;
    });
    if (saturated !== undefined) {
      const addition = Math.max(0, capacities[saturated] - raw[saturated]);
      raw[saturated] += addition;
      remaining -= addition;
      active.delete(saturated);
      continue;
    }
    for (const index of active) {
      raw[index] += (remaining * Math.max(0, weights[index])) / weightTotal;
    }
    remaining = 0;
  }
  const target = Math.round(total - remaining);
  const allocations = raw.map(Math.floor);
  let remainder = target - allocations.reduce((sum, value) => sum + value, 0);
  const priority = raw
    .map((value, index) => ({
      index,
      fraction: value - Math.floor(value),
      capacity: Math.floor(capacities[index]),
    }))
    .sort((left, right) => right.fraction - left.fraction);
  for (const candidate of priority) {
    if (remainder <= 0) break;
    if (allocations[candidate.index] >= candidate.capacity) continue;
    allocations[candidate.index] += 1;
    remainder -= 1;
  }
  return allocations;
}

function responseAtDepth(
  depthMm: number,
  optimized: boolean,
  responseScaleMm = 18,
) {
  return Math.min(
    0.65,
    (1 - Math.exp(-depthMm / responseScaleMm)) * (optimized ? 1.08 : 1),
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
    '分析单元',
    '湿地候选面积_m2',
    '遥感水分压力分',
    '潜在可达性分',
    '情景分配量_m3',
    '等效水深_mm',
    '情景后风险分',
    'NDMI',
    '有效覆盖率',
    '水量情景',
    '分配策略',
    '诊断开始',
    '诊断结束',
  ];
  const rows = plan.units.map((unit) => [
    unit.id,
    unit.name,
    Math.round(unit.candidateWetlandAreaM2),
    unit.stressScore.toFixed(1),
    unit.accessibilityScore?.toFixed(1) ?? '',
    unit.supplyM3,
    unit.equivalentDepthMm.toFixed(2),
    unit.riskAfter.toFixed(1),
    unit.ndmi?.toFixed(4) ?? '',
    unit.validFraction === null
      ? ''
      : `${(unit.validFraction * 100).toFixed(1)}%`,
    `${plan.scenario.label} ${plan.scenario.equivalentDepthMm}mm`,
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
  anchor.download = `shuimai-screening-${plan.scenario.key}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function WaterDecisionPanel({
  evidence,
  scenario,
  onPlanChange,
}: {
  evidence?: GeeEvidence | null;
  scenario?: ScreeningScenario | null;
  onPlanChange?: (plan: DecisionPlan | null) => void;
}) {
  const [strategy, setStrategy] = useState('优先级综合');
  const plan = useMemo<DecisionPlan | null>(() => {
    if (!evidence?.unitMetrics.length || !scenario) return null;
    const prepared = evidence.unitMetrics
      .filter((metric) => (metric.candidateWetlandAreaM2 || 0) > 0)
      .map((metric) => ({
        metric,
        areaM2: metric.candidateWetlandAreaM2 || 0,
        stress: scoreMetric(metric),
        accessibility: clamp((metric.accessibilityScore || 0) / 100),
      }));
    if (!prepared.length) return null;
    const budget = Math.round(scenario.estimatedWaterM3);
    const weights = prepared.map(({ areaM2, stress, accessibility }) => {
      if (strategy === '不补水') return 0;
      if (strategy === '候选区面积') return areaM2;
      if (strategy === '水分压力') return areaM2 * Math.max(stress, 1);
      return (
        Math.sqrt(areaM2) *
        Math.max(stress, 1) ** 1.7 *
        (0.4 + 0.6 * accessibility)
      );
    });
    const requestedM3 = strategy === '不补水' ? 0 : budget;
    const capacities = prepared.map(
      ({ areaM2 }) => (areaM2 * scenario.equivalentDepthMm * 2) / 1000,
    );
    const supplies =
      strategy === '候选区面积'
        ? allocateExact(requestedM3, weights)
        : allocateCappedExact(requestedM3, weights, capacities);
    const units = prepared.map(({ metric, areaM2, stress }, index) => {
      const supplyM3 = supplies[index];
      const equivalentDepthMm = (supplyM3 / areaM2) * 1000;
      const response = responseAtDepth(
        equivalentDepthMm,
        strategy === '优先级综合',
      );
      return {
        id: metric.id,
        name: metric.name,
        candidateWetlandAreaM2: areaM2,
        stressScore: stress,
        riskAfter: stress * (1 - response),
        supplyM3,
        equivalentDepthMm,
        ndmi: metric.ndmi,
        validFraction: metric.validFraction,
        accessibilityScore: metric.accessibilityScore ?? null,
      };
    });
    const usedM3 = units.reduce((sum, unit) => sum + unit.supplyM3, 0);
    const areaTotal = units.reduce(
      (sum, unit) => sum + unit.candidateWetlandAreaM2,
      0,
    );
    const riskBefore =
      units.reduce(
        (sum, unit) => sum + unit.stressScore * unit.candidateWetlandAreaM2,
        0,
      ) / Math.max(areaTotal, 1);
    const riskAtScale = (responseScaleMm: number) =>
      units.reduce(
        (sum, unit) =>
          sum +
          unit.stressScore *
            (1 -
              responseAtDepth(
                unit.equivalentDepthMm,
                strategy === '优先级综合',
                responseScaleMm,
              )) *
            unit.candidateWetlandAreaM2,
        0,
      ) / Math.max(areaTotal, 1);
    const riskAfter = riskAtScale(18);
    const conservativeRisk = riskAtScale(24);
    const optimisticRisk = riskAtScale(12);
    return {
      strategy,
      budgetM3: budget,
      requestedM3,
      usedM3,
      unallocatedM3: 0,
      riskBefore,
      riskAfter,
      improvement:
        riskBefore > 0 ? clamp((riskBefore - riskAfter) / riskBefore) : 0,
      source: 'gee',
      scenario,
      sensitivity: {
        improvementLow: clamp(
          (riskBefore - conservativeRisk) / Math.max(riskBefore, 1),
        ),
        improvementHigh: clamp(
          (riskBefore - optimisticRisk) / Math.max(riskBefore, 1),
        ),
      },
      units,
    };
  }, [evidence, scenario, strategy]);

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
            <span>05</span> SCENARIO PRIORITY
          </div>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[#102f31]">
            补水优先区情景推演
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-[#536965]">
            输出不同水量情景下的空间优先顺序。所有水量都是等效水深换算的情景值，不是实际调度指令。
          </p>
        </div>
        <div className="flex items-center gap-2 border-t border-[#b9d8cf] bg-[#e8f6f1] px-6 py-4 text-sm font-semibold text-[#11614f] lg:border-l lg:border-t-0">
          {plan ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <AlertTriangle className="size-4" />
          )}
          {plan ? '公开数据诊断驱动' : '等待遥感诊断'}
        </div>
      </div>

      {!plan ? (
        <div className="grid min-h-44 place-items-center p-6 text-center text-sm leading-6 text-[#657672]">
          <div>
            <Waves className="mx-auto size-7 text-[#6e928a]" />
            <p className="mt-3 font-semibold text-[#31534d]">
              先完成研究区的公开数据诊断
            </p>
            <p className="mt-1">系统不再使用内置地块或虚拟渠道参数生成结果。</p>
          </div>
        </div>
      ) : (
        <div className="p-6 lg:p-8">
          <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
            <div className="border border-[#c6d0cd] bg-[#f5f8f7] p-5">
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center bg-[#123d3e] text-[#73e0bf]">
                  <SlidersHorizontal className="size-5" />
                </span>
                <div>
                  <p className="text-xs text-[#6a7b77]">当前水量情景</p>
                  <h3 className="font-semibold text-[#173638]">
                    {plan.scenario.label} · {plan.scenario.equivalentDepthMm} mm
                  </h3>
                </div>
              </div>
              <p className="mt-4 border-l-2 border-[#d6a640] bg-white p-3 text-xs leading-5 text-[#667874]">
                候选区面积约
                {(plan.scenario.candidateWetlandAreaM2 / 1_000_000).toFixed(
                  2,
                )}{' '}
                km²，换算情景总量 {formatM3(plan.budgetM3)} m³。
              </p>
              <div className="mt-6 text-sm font-semibold text-[#304b48]">
                排序策略
              </div>
              <div className="mt-2 space-y-2">
                {STRATEGIES.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setStrategy(item.key)}
                    className={`w-full border px-3 py-3 text-left ${strategy === item.key ? 'border-[#13715d] bg-white shadow-[inset_3px_0_0_#36bd98]' : 'border-transparent hover:border-[#bdc9c5] hover:bg-white'}`}
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
                  label="情景总量"
                  value={`${formatM3(plan.usedM3)} m³`}
                  detail="由候选区面积与等效水深换算"
                />
                <Metric
                  icon={<Gauge className="size-4" />}
                  label="情景后风险"
                  value={plan.riskAfter.toFixed(1)}
                  detail={`基线 ${plan.riskBefore.toFixed(1)} 风险分`}
                />
                <Metric
                  icon={<Leaf className="size-4" />}
                  label="模型响应"
                  value={`${(plan.improvement * 100).toFixed(1)}%`}
                  detail="用于方案比较，未经现场标定"
                />
              </div>
              <div className="mt-5 border border-[#c6d0cd] bg-white p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[.14em] text-[#6d7d79]">
                      SCENARIO RESPONSE
                    </p>
                    <h3 className="mt-1 text-lg font-semibold text-[#173638]">
                      情景响应对比
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
                    label="当前情景"
                    value={plan.riskAfter}
                    color="#2da885"
                  />
                </div>
                <p className="mt-4 text-xs leading-5 text-[#71817d]">
                  当水分响应尺度在12—24 mm间变化时，模型响应约为
                  {(plan.sensitivity.improvementLow * 100).toFixed(1)}%—
                  {(plan.sensitivity.improvementHigh * 100).toFixed(1)}
                  %。为避免小斑块获得不合理水深，单元上限设为当前情景平均水深的2倍。
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_320px]">
            <div className="overflow-hidden border border-[#c6d0cd] bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d7dfdc] px-5 py-4">
                <div>
                  <p className="text-xs text-[#6a7b77]">优先级结果</p>
                  <h3 className="mt-1 text-lg font-semibold text-[#173638]">
                    分析单元情景分配
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => downloadPlan(plan, evidence)}
                  className="action-secondary"
                >
                  <Download className="size-4" />
                  导出全部 CSV
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] border-collapse text-sm">
                  <thead>
                    <tr className="bg-[#f5f8f7] text-left text-xs text-[#647570]">
                      <th className="px-5 py-3">分析单元</th>
                      <th className="px-4 py-3">水分压力</th>
                      <th className="px-4 py-3">NDMI</th>
                      <th className="px-4 py-3">潜在可达性</th>
                      <th className="px-4 py-3">情景分配量</th>
                      <th className="px-4 py-3">等效水深</th>
                      <th className="px-5 py-3">情景后风险</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...plan.units]
                      .sort((left, right) => right.supplyM3 - left.supplyM3)
                      .slice(0, 30)
                      .map((unit) => (
                        <tr key={unit.id} className="border-t border-[#e1e7e5]">
                          <td className="px-5 py-4">
                            <span className="font-semibold text-[#173638]">
                              {unit.name}
                            </span>
                            <span className="mt-1 block font-mono text-xs text-[#7a8985]">
                              {unit.id} ·{' '}
                              {(
                                unit.candidateWetlandAreaM2 / 1_000_000
                              ).toFixed(2)}{' '}
                              km²候选区
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
                            {unit.ndmi?.toFixed(3) ?? '—'}
                          </td>
                          <td className="px-4 py-4 font-mono">
                            {unit.accessibilityScore?.toFixed(1) ?? '—'}
                          </td>
                          <td className="px-4 py-4 font-mono font-semibold text-[#9a6b13]">
                            {formatM3(unit.supplyM3)} m³
                          </td>
                          <td className="px-4 py-4 font-mono">
                            {unit.equivalentDepthMm.toFixed(2)} mm
                          </td>
                          <td className="px-5 py-4 font-mono font-semibold text-[#176e5b]">
                            {unit.riskAfter.toFixed(1)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {plan.units.length > 30 && (
                <p className="border-t border-[#e1e7e5] px-5 py-3 text-xs text-[#6d7d79]">
                  页面显示情景分配量最高的30个单元，CSV包含全部
                  {plan.units.length}个单元。
                </p>
              )}
            </div>

            <aside className="bg-[#0d3436] p-5 text-white">
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center bg-[#d9aa45] text-[#123335]">
                  <Waves className="size-5" />
                </span>
                <div>
                  <p className="text-xs text-[#98bbb5]">EVIDENCE TRACE</p>
                  <h3 className="font-semibold">筛查证据链</h3>
                </div>
              </div>
              <ol className="mt-6 space-y-5 text-sm leading-6 text-[#c9ddda]">
                <li className="flex gap-3">
                  <span className="trace-number">1</span>
                  <p>
                    <b className="text-white">候选区：</b>JRC历史水面 + Dynamic
                    World水体/淹水植被概率。
                  </p>
                </li>
                <li className="flex gap-3">
                  <span className="trace-number">2</span>
                  <p>
                    <b className="text-white">需求：</b>55% NDMI亏缺 + 25%
                    MNDWI亏缺 + 20% NDVI弱势。
                  </p>
                </li>
                <li className="flex gap-3">
                  <span className="trace-number">3</span>
                  <p>
                    <b className="text-white">可达性：</b>65%低HAND地形位置 +
                    35%历史水面频率。
                  </p>
                </li>
                <li className="flex gap-3">
                  <span className="trace-number">4</span>
                  <p>
                    <b className="text-white">情景：</b>
                    {plan.scenario.equivalentDepthMm} mm等效水深按
                    {STRATEGIES.find((item) => item.key === strategy)?.label}
                    分配。
                  </p>
                </li>
              </ol>
              <div className="mt-6 border-t border-white/10 pt-4 text-xs leading-5 text-[#99bcb6]">
                <AlertTriangle className="mr-1 inline size-3.5" />
                结果是省域/区域前期筛查，不代表实际渠道可达、已批准用水量或预测生态改善。
              </div>
            </aside>
          </div>
        </div>
      )}
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
          className="block h-full"
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
