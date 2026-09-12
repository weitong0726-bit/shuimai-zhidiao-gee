'use client';

import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CloudRain,
  Database,
  Droplets,
  ShieldCheck,
  Waves,
} from 'lucide-react';

export type AnnualObservation = {
  year: number;
  start: string;
  end: string;
  sceneCount: number;
  ndvi: number | null;
  ndmi: number | null;
  mndwi: number | null;
};

export type ContextEvidence = {
  climate: {
    precipitationMm: number | null;
    potentialEvaporationMm: number | null;
    waterBalanceMm: number | null;
    runoffMm: number | null;
    soilWaterM3m3: number | null;
    source: string;
    scaleM: number;
  };
  waterBaseline: {
    occurrencePct: number | null;
    seasonalityMonths: number | null;
    recentWaterFraction: number | null;
    source: string;
    scaleM: number;
  };
  floodPressureScore: number;
  annualSeries: AnnualObservation[];
  uncertainty: {
    confidence: 'high' | 'medium' | 'low';
    meanValidCoverage: number;
    historicalYears: number;
    ndmiHistoricalMean: number | null;
    ndmiHistoricalStd: number | null;
    ndmiAnomalyZ: number | null;
  };
  methodNote: string;
};

function value(number: number | null, digits = 1, suffix = '') {
  return number === null ? '缺测' : `${number.toFixed(digits)}${suffix}`;
}

function confidenceText(level: ContextEvidence['uncertainty']['confidence']) {
  if (level === 'high') return '证据充分';
  if (level === 'medium') return '证据一般';
  return '证据偏弱';
}

export function EvidenceContextPanel({
  context,
}: {
  context: ContextEvidence;
}) {
  const { climate, waterBaseline, uncertainty } = context;
  const balanceState =
    climate.waterBalanceMm === null
      ? '缺测'
      : climate.waterBalanceMm < 0
        ? '气候水分亏缺'
        : '气候水分盈余';
  const floodState =
    context.floodPressureScore >= 60
      ? '偏高'
      : context.floodPressureScore >= 35
        ? '中等'
        : '偏低';

  return (
    <section
      className="mt-6 overflow-hidden border border-[#b9c7c3] bg-white"
      aria-labelledby="context-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#d7dfdc] bg-[#f5f8f7] px-6 py-5 lg:px-8">
        <div>
          <div className="eyebrow">
            <span>03</span> CONTEXT
          </div>
          <h2
            id="context-title"
            className="mt-2 text-2xl font-semibold text-[#123638]"
          >
            气候、水面与历史背景
          </h2>
          <p className="mt-2 text-sm leading-6 text-[#5c706b]">
            把当期遥感状态放回同季节历史和水量收支中解释，避免只看一张指数图。
          </p>
        </div>
        <span
          className={`status-pill ${uncertainty.confidence === 'high' ? 'safe' : uncertainty.confidence === 'medium' ? 'warning' : 'danger'}`}
        >
          {uncertainty.confidence === 'high' ? (
            <ShieldCheck className="size-3.5" />
          ) : (
            <AlertTriangle className="size-3.5" />
          )}
          {confidenceText(uncertainty.confidence)}
        </span>
      </div>

      <div className="grid gap-px bg-[#cbd5d2] sm:grid-cols-2 xl:grid-cols-4">
        <ContextMetric
          icon={<CloudRain className="size-4" />}
          label="降水－潜在蒸发"
          value={value(climate.waterBalanceMm, 1, ' mm')}
          detail={balanceState}
        />
        <ContextMetric
          icon={<Waves className="size-4" />}
          label="地表与地下径流"
          value={value(climate.runoffMm, 1, ' mm')}
          detail={`ERA5-Land ${Math.round(climate.scaleM / 1000)} km网格`}
        />
        <ContextMetric
          icon={<Droplets className="size-4" />}
          label="表层土壤含水率"
          value={value(climate.soilWaterM3m3, 3)}
          detail="0—7 cm土层体积含水率"
        />
        <ContextMetric
          icon={<AlertTriangle className="size-4" />}
          label="洪水压力筛查"
          value={`${context.floodPressureScore.toFixed(1)} / 100`}
          detail={`${floodState} · 非水动力模型`}
        />
      </div>

      <div className="grid lg:grid-cols-[1fr_330px]">
        <div className="overflow-x-auto p-6 lg:p-8">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-[#6b7b77]">近5年同季节窗口</p>
              <h3 className="mt-1 text-lg font-semibold text-[#173638]">
                遥感时间序列
              </h3>
            </div>
            <span className="text-right text-xs leading-5 text-[#6b7b77]">
              NDMI异常值
              <br />
              <b className="font-mono text-[#173638]">
                {value(uncertainty.ndmiAnomalyZ, 2, ' σ')}
              </b>
            </span>
          </div>
          <table className="mt-4 w-full min-w-[620px] text-sm">
            <thead>
              <tr className="border-y border-[#dbe2df] bg-[#f6f8f7] text-left text-xs text-[#667672]">
                <th className="px-3 py-2.5">年份</th>
                <th className="px-3 py-2.5">影像</th>
                <th className="px-3 py-2.5">NDVI</th>
                <th className="px-3 py-2.5">NDMI</th>
                <th className="px-3 py-2.5">MNDWI</th>
                <th className="px-3 py-2.5">NDMI相对位置</th>
              </tr>
            </thead>
            <tbody>
              {context.annualSeries.map((row) => {
                const bar =
                  row.ndmi === null
                    ? 0
                    : Math.max(
                        2,
                        Math.min(100, ((row.ndmi + 0.5) / 1.15) * 100),
                      );
                return (
                  <tr key={row.year} className="border-b border-[#e3e8e6]">
                    <td className="px-3 py-3 font-semibold">{row.year}</td>
                    <td className="px-3 py-3 font-mono">{row.sceneCount}景</td>
                    <td className="px-3 py-3 font-mono">
                      {value(row.ndvi, 3)}
                    </td>
                    <td className="px-3 py-3 font-mono">
                      {value(row.ndmi, 3)}
                    </td>
                    <td className="px-3 py-3 font-mono">
                      {value(row.mndwi, 3)}
                    </td>
                    <td
                      className="px-3 py-3"
                      aria-label={`NDMI相对位置 ${bar.toFixed(0)}%`}
                    >
                      <span className="block h-2 w-32 bg-[#e6ecea]">
                        <span
                          className="block h-full bg-[#2c9278]"
                          style={{ width: `${bar}%` }}
                        />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-xs leading-5 text-[#6c7c78]">
            每年采用与当前起止日期相同长度的季节窗口；异常值以此前年份NDMI均值和标准差计算。
          </p>
        </div>

        <aside className="border-t border-[#d7dfdc] bg-[#f7f9f8] p-6 lg:border-l lg:border-t-0">
          <div className="flex items-center gap-2 text-[#315b53]">
            <Database className="size-4" />
            <h3 className="font-semibold">判读依据</h3>
          </div>
          <dl className="mt-5 space-y-4 text-sm">
            <div>
              <dt className="text-[#6b7b77]">历史水面出现频率</dt>
              <dd className="mt-1 font-mono font-semibold text-[#173638]">
                {value(waterBaseline.occurrencePct, 1, '%')}
              </dd>
            </div>
            <div>
              <dt className="text-[#6b7b77]">平均季节性水面</dt>
              <dd className="mt-1 font-mono font-semibold text-[#173638]">
                {value(waterBaseline.seasonalityMonths, 1, ' 月/年')}
              </dd>
            </div>
            <div>
              <dt className="text-[#6b7b77]">当期识别水面占比</dt>
              <dd className="mt-1 font-mono font-semibold text-[#173638]">
                {waterBaseline.recentWaterFraction === null
                  ? '缺测'
                  : `${(waterBaseline.recentWaterFraction * 100).toFixed(2)}%`}
              </dd>
            </div>
            <div>
              <dt className="text-[#6b7b77]">当期有效覆盖</dt>
              <dd className="mt-1 font-mono font-semibold text-[#173638]">
                {(uncertainty.meanValidCoverage * 100).toFixed(1)}%
              </dd>
            </div>
          </dl>
          <p className="mt-5 border-t border-[#d7dfdc] pt-4 text-xs leading-5 text-[#6a7a76]">
            {context.methodNote}
          </p>
        </aside>
      </div>
    </section>
  );
}

function ContextMetric({
  icon,
  label,
  value: metricValue,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="bg-white px-5 py-4">
      <span className="flex items-center gap-2 text-xs font-medium text-[#647570]">
        {icon}
        {label}
      </span>
      <strong className="mt-2 block font-mono text-xl text-[#153638]">
        {metricValue}
      </strong>
      <span className="mt-1 block text-xs text-[#75847f]">{detail}</span>
    </div>
  );
}
