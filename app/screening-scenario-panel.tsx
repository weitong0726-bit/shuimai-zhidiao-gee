'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Droplets, Map, Mountain, Waves } from 'lucide-react';
import type { GeeUnitMetric } from './water-decision-panel';

export type ScreeningScenario = {
  key: 'low' | 'medium' | 'high';
  label: string;
  equivalentDepthMm: number;
  estimatedWaterM3: number;
  candidateWetlandAreaM2: number;
};

const SCENARIOS = [
  {
    key: 'low' as const,
    label: '低水量情景',
    equivalentDepthMm: 2,
    detail: '候选区平均2 mm等效水深',
  },
  {
    key: 'medium' as const,
    label: '中水量情景',
    equivalentDepthMm: 5,
    detail: '候选区平均5 mm等效水深',
  },
  {
    key: 'high' as const,
    label: '高水量情景',
    equivalentDepthMm: 10,
    detail: '候选区平均10 mm等效水深',
  },
];

function number(value: number) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(
    Math.max(0, value),
  );
}

export function ScreeningScenarioPanel({
  units,
  onChange,
}: {
  units: GeeUnitMetric[];
  onChange?: (scenario: ScreeningScenario) => void;
}) {
  const [selected, setSelected] = useState<ScreeningScenario['key']>('medium');
  const candidateWetlandAreaM2 = useMemo(
    () =>
      units.reduce((sum, unit) => sum + (unit.candidateWetlandAreaM2 || 0), 0),
    [units],
  );
  const scenario = useMemo<ScreeningScenario>(() => {
    const item =
      SCENARIOS.find((candidate) => candidate.key === selected) || SCENARIOS[1];
    return {
      key: item.key,
      label: item.label,
      equivalentDepthMm: item.equivalentDepthMm,
      estimatedWaterM3:
        (candidateWetlandAreaM2 * item.equivalentDepthMm) / 1000,
      candidateWetlandAreaM2,
    };
  }, [candidateWetlandAreaM2, selected]);

  useEffect(() => {
    onChange?.(scenario);
  }, [onChange, scenario]);

  const ranked = [...units]
    .filter((unit) => (unit.candidateWetlandAreaM2 || 0) > 0)
    .sort(
      (left, right) =>
        (right.accessibilityScore || 0) - (left.accessibilityScore || 0),
    );

  return (
    <section
      className="mt-6 overflow-hidden border border-[#b9c7c3] bg-white"
      aria-labelledby="screening-scenario-title"
    >
      <div className="grid border-b border-[#d7dfdc] bg-[#f5f8f7] lg:grid-cols-[1fr_auto]">
        <div className="px-6 py-5 lg:px-8">
          <div className="eyebrow">
            <span>04</span> POTENTIAL ACCESS
          </div>
          <h2
            id="screening-scenario-title"
            className="mt-2 text-2xl font-semibold text-[#123638]"
          >
            潜在可达性与水量情景
          </h2>
          <p className="mt-2 text-sm leading-6 text-[#5c706b]">
            使用JRC历史水面和MERIT
            Hydro地形位置评估潜在可达性；三档水量只用于方案比选，不代表已批准调水量。
          </p>
        </div>
        <div className="flex items-center gap-2 border-t border-[#b9d8cf] bg-[#e8f6f1] px-6 py-4 text-sm font-semibold text-[#11614f] lg:border-l lg:border-t-0">
          <CheckCircle2 className="size-4" />
          公开数据筛查模式
        </div>
      </div>

      <div className="grid gap-px bg-[#cbd5d2] lg:grid-cols-[1.05fr_.95fr]">
        <div className="bg-white p-6 lg:p-8">
          <p className="text-sm font-semibold text-[#294b46]">
            选择等效补水情景
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {SCENARIOS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setSelected(item.key)}
                className={`border p-4 text-left ${selected === item.key ? 'border-[#18725f] bg-[#edf7f3] shadow-[inset_3px_0_0_#2eaa87]' : 'border-[#cbd5d2] bg-white hover:border-[#7ca99d]'}`}
              >
                <span className="block text-sm font-semibold text-[#173638]">
                  {item.label}
                </span>
                <strong className="mt-2 block font-mono text-2xl text-[#9a6b13]">
                  {item.equivalentDepthMm} mm
                </strong>
                <span className="mt-2 block text-xs leading-5 text-[#6d7d79]">
                  {item.detail}
                </span>
              </button>
            ))}
          </div>
        </div>
        <dl className="grid gap-px bg-[#cbd5d2] sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <div className="bg-white p-6">
            <dt className="flex items-center gap-2 text-xs text-[#667672]">
              <Map className="size-4" />
              湿地候选区面积
            </dt>
            <dd className="mt-3 font-mono text-xl font-semibold text-[#173638]">
              {(candidateWetlandAreaM2 / 1_000_000).toFixed(2)} km²
            </dd>
          </div>
          <div className="bg-white p-6">
            <dt className="flex items-center gap-2 text-xs text-[#667672]">
              <Droplets className="size-4" />
              情景总量（估算）
            </dt>
            <dd className="mt-3 font-mono text-xl font-semibold text-[#173638]">
              {number(scenario.estimatedWaterM3)} m³
            </dd>
          </div>
        </dl>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-y border-[#dce3e0] bg-[#f7f9f8] text-left text-xs text-[#647570]">
              <th className="px-6 py-3">分析单元</th>
              <th className="px-4 py-3">湿地候选面积</th>
              <th className="px-4 py-3">单元占比</th>
              <th className="px-4 py-3">HAND</th>
              <th className="px-6 py-3">潜在可达性</th>
            </tr>
          </thead>
          <tbody>
            {ranked.slice(0, 20).map((unit) => (
              <tr
                key={unit.id}
                className="border-b border-[#e3e8e6] last:border-0"
              >
                <td className="px-6 py-3 font-semibold text-[#173638]">
                  {unit.name}
                </td>
                <td className="px-4 py-3 font-mono">
                  {((unit.candidateWetlandAreaM2 || 0) / 1_000_000).toFixed(2)}{' '}
                  km²
                </td>
                <td className="px-4 py-3 font-mono">
                  {unit.candidateWetlandFraction == null
                    ? '—'
                    : `${(unit.candidateWetlandFraction * 100).toFixed(2)}%`}
                </td>
                <td className="px-4 py-3 font-mono">
                  {unit.meanHandM == null
                    ? '—'
                    : `${unit.meanHandM.toFixed(1)} m`}
                </td>
                <td className="px-6 py-3">
                  <span className="inline-flex items-center gap-2 font-mono font-semibold text-[#1c6d5b]">
                    <Waves className="size-3.5" />
                    {unit.accessibilityScore?.toFixed(1) ?? '—'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[#dce3e0] bg-[#f7f9f8] px-6 py-3 text-xs leading-5 text-[#687873]">
        <Mountain className="mr-1 inline size-3.5" />
        潜在可达性由65%的低HAND地形位置和35%的历史水面频率组成，不等同于实际渠道连通性。表格仅显示潜在可达性较高的前20个单元。
      </p>
    </section>
  );
}
