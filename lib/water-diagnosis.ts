export type WeatherDay = { date: string; rain: number; et0: number };
export type WaterParameters = {
  theta_initial: number; theta_wp: number; theta_critical: number; theta_max: number;
  root_depth_mm: number; kc: number; effective_rain_fraction: number; net_loss_mm_day: number;
};
export const scenarioDefaults: WaterParameters = {
  theta_initial: 0.18, theta_wp: 0.10, theta_critical: 0.23, theta_max: 0.35,
  root_depth_mm: 400, kc: 0.9, effective_rain_fraction: 0.8, net_loss_mm_day: 0.5,
};
export function diagnoseWater(areaM2: number, p: WaterParameters, days: WeatherDay[]) {
  if (!Number.isFinite(areaM2) || areaM2 <= 0) throw new Error('地块面积必须大于0。');
  if (Object.values(p).some((value) => !Number.isFinite(value))) throw new Error('请填写全部参数，不能留空。');
  if (!(0 <= p.theta_wp && p.theta_wp <= p.theta_initial && p.theta_initial <= p.theta_max && p.theta_wp < p.theta_critical && p.theta_critical <= p.theta_max && p.theta_max <= 1)) throw new Error('含水率需满足：0 ≤ 萎蔫点 ≤ 初始值 ≤ 容量上限 ≤ 1，且萎蔫点 < 生态阈值 ≤ 容量上限。');
  if (p.root_depth_mm <= 0 || p.root_depth_mm > 10000 || p.kc < 0 || p.kc > 5 || p.net_loss_mm_day < 0 || p.net_loss_mm_day > 100 || p.effective_rain_fraction < 0 || p.effective_rain_fraction > 1) throw new Error('检查根深、植被系数、有效降水比例和日净损失的范围。');
  if (days.length !== 7 || days.some((d, i) => !Number.isFinite(d.rain) || d.rain < 0 || !Number.isFinite(d.et0) || d.et0 < 0 || !Number.isFinite(Date.parse(d.date)) || (i > 0 && Date.parse(d.date) - Date.parse(days[i - 1].date) !== 86400000))) throw new Error('需要连续7天且无缺测的降水和参考蒸散数据。');
  let storage = (p.theta_initial - p.theta_wp) * p.root_depth_mm;
  const capacity = (p.theta_max - p.theta_wp) * p.root_depth_mm;
  const critical = (p.theta_critical - p.theta_wp) * p.root_depth_mm;
  const trajectory = days.map((day) => {
    const before = storage;
    const effectiveRain = day.rain * p.effective_rain_fraction;
    let available = before + effectiveRain;
    const overflow = Math.max(0, available - capacity);
    available -= overflow;
    const actualEt = Math.min(available, day.et0 * p.kc);
    available -= actualEt;
    const drainage = Math.min(available, p.net_loss_mm_day);
    storage = available - drainage;
    const deficitRatio = Math.max(0, critical - storage) / critical;
    return { ...day, theta: storage / p.root_depth_mm + p.theta_wp, deficitRatio, effectiveRain, overflow, actualEt, drainage, residual: before + effectiveRain - overflow - actualEt - drainage - storage };
  });
  const deficitDays = trajectory.filter((row) => row.deficitRatio > 1e-10).length;
  return {
    trajectory, deficitDays,
    loss: trajectory.reduce((sum, row) => sum + row.deficitRatio * areaM2 / 10000, 0),
    initialDeficitM3: Math.max(0, p.theta_critical - p.theta_initial) * p.root_depth_mm * areaM2 / 1000,
    maxDeficitRatio: Math.max(...trajectory.map((row) => row.deficitRatio)),
  };
}
