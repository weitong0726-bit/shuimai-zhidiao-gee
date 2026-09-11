import type { WeatherDay } from '@/lib/water-diagnosis';

const cache = new Map<string, { expires: number; payload: unknown }>();
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const lat = Number(query.get('latitude')), lon = Number(query.get('longitude'));
  const start = query.get('start') || '';
  if (!query.has('latitude') || !query.has('longitude') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(start)) || new Date(start).toISOString().slice(0, 10) !== start) return Response.json({ error: '请填写有效坐标与起始日期。' }, { status: 400 });
  const end = new Date(Date.parse(start) + 6 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const archive = Date.parse(end) <= Date.parse(today) - 7 * 86400000;
  if (start < '1940-01-01' || (!archive && start < today) || start > new Date(Date.parse(today) + 9 * 86400000).toISOString().slice(0, 10)) return Response.json({ error: '历史回放请选择结束时间距今天至少7天的窗口；预测请选择今天至未来9天内的起始日期。' }, { status: 400 });
  const url = new URL(archive ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), start_date: start, end_date: end, daily: 'precipitation_sum,et0_fao_evapotranspiration', timezone: 'GMT', ...(archive ? { models: 'era5' } : {}) }).toString();
  const key = url.toString();
  const saved = cache.get(key);
  if (saved && saved.expires > Date.now()) return Response.json(saved.payload);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`气象服务暂不可用（${response.status}），请稍后重试。`);
    const data = await response.json() as { latitude: number; longitude: number; daily_units?: Record<string, string>; daily?: { time: string[]; precipitation_sum: Array<number | null>; et0_fao_evapotranspiration: Array<number | null> } };
    const d = data.daily;
    if (!d || d.time?.length !== 7 || d.precipitation_sum?.length !== 7 || d.et0_fao_evapotranspiration?.length !== 7 || data.daily_units?.precipitation_sum !== 'mm' || data.daily_units?.et0_fao_evapotranspiration !== 'mm') throw new Error('气象数据不足7天或单位不符，不能进行诊断。');
    const days: WeatherDay[] = d.time.map((date, i) => {
      const rain = d.precipitation_sum[i], et0 = d.et0_fao_evapotranspiration[i];
      if (date !== new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10) || typeof rain !== 'number' || !Number.isFinite(rain) || rain < 0 || typeof et0 !== 'number' || !Number.isFinite(et0) || et0 < 0) throw new Error('气象数据存在缺测或日期不连续，请更换窗口。');
      return { date, rain, et0 };
    });
    const payload = { days, start, end, mode: archive ? 'historical' : 'forecast', source: archive ? 'Open-Meteo / ERA5 历史再分析' : 'Open-Meteo 多模式天气预报', timezone: 'UTC', requestedLocation: [lon, lat], gridLocation: [data.longitude, data.latitude], sourceUrl: key, retrievedAt: new Date().toISOString() };
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 3600000, payload });
    return Response.json(payload);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '气象读取失败，请重试。' }, { status: 502 });
  }
}
