'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Network,
  Route,
  Waves,
} from 'lucide-react';
import type { GeeUnitMetric } from './water-decision-panel';

export type RouteStatus = 'open' | 'limited' | 'closed';
export type UnitDeliveryConstraint = {
  status: RouteStatus;
  efficiency: number;
  maxDeliveryM3: number;
  sourceName: string;
};
export type DeliveryNetwork = {
  sourceName: string;
  availableM3: number;
  constraints: Record<string, UnitDeliveryConstraint>;
};

function defaultLimit(unit: GeeUnitMetric) {
  return (
    Math.round(Math.max(5000, (unit.areaM2 || 500_000) * 0.012) / 500) * 500
  );
}

function statusText(status: RouteStatus) {
  if (status === 'open') return '畅通';
  if (status === 'limited') return '受限';
  return '中断';
}

export function WaterNetworkPanel({
  units,
  onChange,
}: {
  units: GeeUnitMetric[];
  onChange?: (network: DeliveryNetwork) => void;
}) {
  const [sourceName, setSourceName] = useState('生态水源');
  const [availableM3, setAvailableM3] = useState(
    () =>
      Math.round(
        units.reduce((sum, unit) => sum + (unit.areaM2 || 500_000) * 0.01, 0) /
          1000,
      ) * 1000,
  );
  const [constraints, setConstraints] = useState<
    Record<string, UnitDeliveryConstraint>
  >(() =>
    Object.fromEntries(
      units.map((unit) => [
        unit.id,
        {
          status: 'open' as const,
          efficiency: 0.8,
          maxDeliveryM3: defaultLimit(unit),
          sourceName: '生态水源',
        },
      ]),
    ),
  );

  const network = useMemo<DeliveryNetwork>(
    () => ({
      sourceName,
      availableM3: Math.max(0, availableM3),
      constraints: Object.fromEntries(
        Object.entries(constraints).map(([id, item]) => [
          id,
          { ...item, sourceName },
        ]),
      ),
    }),
    [availableM3, constraints, sourceName],
  );

  useEffect(() => {
    onChange?.(network);
  }, [network, onChange]);

  const routeCapacity = units.reduce((sum, unit) => {
    const route = constraints[unit.id];
    return sum + (route?.status === 'closed' ? 0 : route?.maxDeliveryM3 || 0);
  }, 0);
  const deliverable = Math.min(network.availableM3, routeCapacity);
  const reachable = units.filter(
    (unit) => constraints[unit.id]?.status !== 'closed',
  ).length;

  function updateUnit(id: string, patch: Partial<UnitDeliveryConstraint>) {
    setConstraints((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }));
  }

  return (
    <section
      className="mt-6 overflow-hidden border border-[#b9c7c3] bg-white"
      aria-labelledby="network-title"
    >
      <div className="grid border-b border-[#d7dfdc] bg-[#f5f8f7] lg:grid-cols-[1fr_auto]">
        <div className="px-6 py-5 lg:px-8">
          <div className="eyebrow">
            <span>04</span> DELIVERY NETWORK
          </div>
          <h2
            id="network-title"
            className="mt-2 text-2xl font-semibold text-[#123638]"
          >
            水源与输水连通性
          </h2>
          <p className="mt-2 text-sm leading-6 text-[#5c706b]">
            先核实水能否到达，再参与补水分配。中断线路自动剔除，受限线路按上限约束。
          </p>
        </div>
        <div
          className={`flex items-center gap-2 border-t px-6 py-4 text-sm font-semibold lg:border-l lg:border-t-0 ${reachable === units.length ? 'border-[#b9d8cf] bg-[#e8f6f1] text-[#11614f]' : 'border-[#ead3a5] bg-[#fff8e8] text-[#7b591b]'}`}
        >
          {reachable === units.length ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <AlertTriangle className="size-4" />
          )}
          {reachable}/{units.length} 个单元可达
        </div>
      </div>

      <div className="grid gap-px bg-[#cbd5d2] sm:grid-cols-3">
        <label className="bg-white p-5 text-sm">
          <span className="flex items-center gap-2 text-xs text-[#667672]">
            <Waves className="size-4" />
            水源名称
          </span>
          <input
            value={sourceName}
            onChange={(event) => setSourceName(event.target.value.slice(0, 40))}
            className="mt-2 w-full border-0 border-b bg-transparent px-0 py-2 font-semibold outline-none"
          />
        </label>
        <label className="bg-white p-5 text-sm">
          <span className="flex items-center gap-2 text-xs text-[#667672]">
            <Gauge className="size-4" />
            本次可供水量
          </span>
          <span className="mt-2 flex items-center border-b">
            <input
              aria-label="本次可供水量"
              type="number"
              min="0"
              max="10000000"
              step="500"
              value={availableM3}
              onChange={(event) =>
                setAvailableM3(Math.max(0, Number(event.target.value) || 0))
              }
              className="min-w-0 flex-1 border-0 bg-transparent px-0 py-2 font-mono text-lg font-semibold outline-none"
            />
            <span className="text-xs text-[#6b7b77]">m³</span>
          </span>
        </label>
        <div className="bg-white p-5">
          <span className="flex items-center gap-2 text-xs text-[#667672]">
            <Network className="size-4" />
            网络可调度上限
          </span>
          <strong className="mt-3 block font-mono text-xl text-[#173638]">
            {new Intl.NumberFormat('zh-CN').format(deliverable)} m³
          </strong>
          <span className="mt-1 block text-xs text-[#72817d]">
            取水源能力与线路上限的较小值
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[850px] text-sm">
          <thead>
            <tr className="border-b border-[#dce3e0] bg-[#f7f9f8] text-left text-xs text-[#647570]">
              <th className="px-6 py-3">目标单元</th>
              <th className="px-4 py-3">线路状态</th>
              <th className="px-4 py-3">到达效率</th>
              <th className="px-4 py-3">线路输水上限</th>
              <th className="px-6 py-3">约束结果</th>
            </tr>
          </thead>
          <tbody>
            {units.map((unit) => {
              const route = constraints[unit.id];
              return (
                <tr
                  key={unit.id}
                  className="border-b border-[#e3e8e6] last:border-0"
                >
                  <td className="px-6 py-4">
                    <b className="text-[#173638]">{unit.name}</b>
                    <span className="mt-1 block font-mono text-xs text-[#74837f]">
                      {unit.id}
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <select
                      aria-label={`${unit.name}线路状态`}
                      value={route.status}
                      onChange={(event) =>
                        updateUnit(unit.id, {
                          status: event.target.value as RouteStatus,
                        })
                      }
                      className="w-full border bg-white px-3 py-2"
                    >
                      <option value="open">畅通</option>
                      <option value="limited">受限</option>
                      <option value="closed">中断</option>
                    </select>
                  </td>
                  <td className="px-4 py-4">
                    <span className="flex items-center gap-2">
                      <input
                        aria-label={`${unit.name}到达效率`}
                        type="number"
                        min="10"
                        max="100"
                        step="5"
                        value={Math.round(route.efficiency * 100)}
                        onChange={(event) =>
                          updateUnit(unit.id, {
                            efficiency: Math.max(
                              0.1,
                              Math.min(
                                1,
                                (Number(event.target.value) || 10) / 100,
                              ),
                            ),
                          })
                        }
                        className="w-20 border px-3 py-2 font-mono"
                      />
                      <span>%</span>
                    </span>
                  </td>
                  <td className="px-4 py-4">
                    <span className="flex items-center gap-2">
                      <input
                        aria-label={`${unit.name}线路输水上限`}
                        type="number"
                        min="0"
                        max="10000000"
                        step="500"
                        value={route.maxDeliveryM3}
                        disabled={route.status === 'closed'}
                        onChange={(event) =>
                          updateUnit(unit.id, {
                            maxDeliveryM3: Math.max(
                              0,
                              Number(event.target.value) || 0,
                            ),
                          })
                        }
                        className="w-32 border px-3 py-2 font-mono disabled:bg-[#eef1f0]"
                      />
                      <span>m³</span>
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`status-pill ${route.status === 'open' ? 'safe' : route.status === 'limited' ? 'warning' : 'danger'}`}
                    >
                      <Route className="size-3.5" />
                      {statusText(route.status)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-[#dce3e0] bg-[#f7f9f8] px-6 py-3 text-xs leading-5 text-[#687873]">
        这是最小可用输水网络：每条线路表示“水源—闸门/渠道—管理单元”的综合路径。正式应用可由渠道拓扑和实时闸门数据替换。
      </p>
    </section>
  );
}
