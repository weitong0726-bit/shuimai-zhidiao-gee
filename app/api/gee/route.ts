import earthEngineModule from '@google/earthengine';
import { env } from 'cloudflare:workers';

type GeeIndex = 'RGB' | 'NDVI' | 'NDMI' | 'MNDWI';
type ServiceAccount = {
  type: 'service_account';
  project_id: string;
  client_email: string;
  private_key: string;
};
type RuntimeEnv = { GEE_SERVICE_ACCOUNT_JSON?: string };
type EeObject = { [key: string]: (...args: unknown[]) => EeObject };
type EeApi = {
  reset?: () => void;
  data: { setAuthToken: (...args: unknown[]) => void };
  initialize: (...args: unknown[]) => void;
  Geometry: {
    Polygon: (coordinates: unknown) => EeObject;
    MultiPolygon: (coordinates: unknown) => EeObject;
  };
  Feature: (geometry: EeObject, properties?: Record<string, unknown>) => EeObject;
  FeatureCollection: (value: unknown) => EeObject;
  ImageCollection: (assetId: string) => EeObject;
  Filter: { lt: (property: string, value: number) => unknown };
  Reducer: { mean: () => unknown };
  Serializer: { encodeCloudApi: (value: EeObject) => Record<string, unknown> };
};

const ee = earthEngineModule as EeApi;
const requestBuckets = new Map<string, { count: number; resetAt: number }>();
type GeeAuth = { token: string; projectId: string; expiresAt: number };
let initialization: Promise<GeeAuth> | null = null;

function readServiceAccount() {
  const raw = (env as unknown as RuntimeEnv).GEE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GEE_SERVER_NOT_CONFIGURED');
  const key = JSON.parse(raw) as Partial<ServiceAccount>;
  if (key.type !== 'service_account' || !key.project_id || !key.client_email || !key.private_key) {
    throw new Error('GEE_SERVER_CREDENTIAL_INVALID');
  }
  return key as ServiceAccount;
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function encodeJson(value: unknown) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function serviceAccountToken(key: ServiceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
  const claims = encodeJson({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/earthengine https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const unsigned = `${header}.${claims}`;
  const der = Uint8Array.from(
    atob(key.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')),
    (character) => character.charCodeAt(0),
  );
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const payload = await response.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || 'GEE_TOKEN_FAILED');
  return { token: payload.access_token, expiresIn: payload.expires_in || 3600 };
}

async function initializeGee() {
  if (initialization) {
    const cached = await initialization;
    if (cached.expiresAt > Date.now() + 60_000) return cached;
    initialization = null;
  }
  if (!initialization) {
    initialization = (async () => {
      const key = readServiceAccount();
      const { token, expiresIn } = await serviceAccountToken(key);
      ee.reset?.();
      await new Promise<void>((resolve, reject) => {
        ee.data.setAuthToken(
          key.client_email,
          'Bearer',
          token,
          expiresIn,
          ['https://www.googleapis.com/auth/earthengine', 'https://www.googleapis.com/auth/cloud-platform'],
          () => ee.initialize(null, null, resolve, reject, null, key.project_id),
          false,
          true,
        );
      });
      return {
        token,
        projectId: key.project_id,
        expiresAt: Date.now() + Math.max(expiresIn - 60, 60) * 1000,
      };
    })().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

function evaluate<T>(object: EeObject) {
  return new Promise<T>((resolve, reject) => {
    object.evaluate((value: unknown, error: unknown) => error ? reject(error) : resolve(value as T));
  });
}

function boundsOf(features: Array<{ geometry?: unknown }>) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      minX = Math.min(minX, value[0]);
      minY = Math.min(minY, value[1]);
      maxX = Math.max(maxX, value[0]);
      maxY = Math.max(maxY, value[1]);
      return;
    }
    value.forEach(walk);
  };
  features.forEach((feature) => walk((feature.geometry as { coordinates?: unknown })?.coordinates));
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || minX < -180 || maxX > 180 || minY < -90 || maxY > 90) {
    throw new Error('研究区坐标必须是WGS84经纬度（EPSG:4326）。');
  }
  if (maxX <= minX || maxY <= minY) throw new Error('研究区边界范围无效。');
  return { minX, minY, maxX, maxY };
}

function pixelGrid(bounds: ReturnType<typeof boundsOf>) {
  const paddingX = Math.max((bounds.maxX - bounds.minX) * 0.025, 0.0001);
  const paddingY = Math.max((bounds.maxY - bounds.minY) * 0.025, 0.0001);
  const minX = bounds.minX - paddingX;
  const maxX = bounds.maxX + paddingX;
  const minY = bounds.minY - paddingY;
  const maxY = bounds.maxY + paddingY;
  const latitude = (minY + maxY) / 2;
  const displayRatio = ((maxX - minX) * Math.max(Math.cos(latitude * Math.PI / 180), 0.15)) / (maxY - minY);
  let width = 1000;
  let height = Math.max(180, Math.round(width / displayRatio));
  if (height > 700) {
    height = 700;
    width = Math.max(180, Math.round(height * displayRatio));
  }
  return {
    dimensions: { width, height },
    affineTransform: {
      scaleX: (maxX - minX) / width,
      shearX: 0,
      translateX: minX,
      shearY: 0,
      scaleY: -(maxY - minY) / height,
      translateY: maxY,
    },
    crsCode: 'EPSG:4326',
  };
}

function pngDataUrl(bytes: ArrayBuffer) {
  const data = new Uint8Array(bytes);
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

async function computePng(
  image: EeObject,
  auth: GeeAuth,
  grid: ReturnType<typeof pixelGrid>,
  bandIds: string[],
  visualizationOptions: Record<string, unknown>,
) {
  const response = await fetch(`https://earthengine.googleapis.com/v1/projects/${encodeURIComponent(auth.projectId)}/image:computePixels`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      expression: ee.Serializer.encodeCloudApi(image),
      fileFormat: 'PNG',
      grid,
      bandIds,
      visualizationOptions,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GEE_COMPUTE_PIXELS_${response.status}: ${detail.slice(0, 1000)}`);
  }
  return pngDataUrl(await response.arrayBuffer());
}

function validateRequest(payload: unknown) {
  if (!payload || typeof payload !== 'object') throw new Error('请求内容无效。');
  const input = payload as { boundary?: unknown; start?: unknown; end?: unknown; index?: unknown };
  const boundary = input.boundary as { type?: unknown; features?: Array<{ geometry?: unknown; properties?: Record<string, unknown> }> };
  if (boundary?.type !== 'FeatureCollection' || !Array.isArray(boundary.features) || boundary.features.length < 1 || boundary.features.length > 100) {
    throw new Error('研究区必须包含1—100个面要素。');
  }
  const features = boundary.features;
  const text = JSON.stringify(boundary);
  if (text.length > 1_500_000) throw new Error('研究区边界过于复杂，请先简化边界。');
  const start = typeof input.start === 'string' ? input.start : '';
  const end = typeof input.end === 'string' ? input.end : '';
  const index = input.index as GeeIndex;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start >= end) throw new Error('分析日期无效。');
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (days > 366) throw new Error('单次分析时间范围不能超过366天。');
  if (!['RGB', 'NDVI', 'NDMI', 'MNDWI'].includes(index)) throw new Error('分析指标无效。');
  return { boundary: { type: 'FeatureCollection' as const, features }, start, end, index };
}

function checkRateLimit(request: Request) {
  const key = request.headers.get('cf-connecting-ip') || 'local';
  const now = Date.now();
  const existing = requestBuckets.get(key);
  if (!existing || existing.resetAt < now) {
    requestBuckets.set(key, { count: 1, resetAt: now + 3_600_000 });
    return;
  }
  if (existing.count >= 12) throw new Error('RATE_LIMITED');
  existing.count += 1;
}

function geeGeometry(value: unknown) {
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (geometry?.type === 'Polygon') return ee.Geometry.Polygon(geometry.coordinates);
  if (geometry?.type === 'MultiPolygon') return ee.Geometry.MultiPolygon(geometry.coordinates);
  throw new Error('研究区只能包含Polygon或MultiPolygon面要素。');
}

function publicError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('GEE_SERVER_NOT_CONFIGURED')) return ['网站的GEE服务账号尚未配置。', 503] as const;
  if (message.includes('GEE_SERVER_CREDENTIAL_INVALID')) return ['网站的GEE服务账号密钥无效。', 503] as const;
  if (message.includes('RATE_LIMITED')) return ['当前设备请求过于频繁，请稍后再试。', 429] as const;
  if (/permission|403|not registered|not authorized/i.test(message)) return ['GEE项目权限不足，请检查服务账号角色和项目注册状态。', 502] as const;
  return [message || 'GEE分析失败。', 500] as const;
}

export async function GET() {
  try {
    const key = readServiceAccount();
    return Response.json({ configured: true, projectId: key.project_id });
  } catch {
    return Response.json({ configured: false }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let stage = 'request';
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 2_000_000) return Response.json({ error: '研究区文件过大。' }, { status: 413 });
    checkRateLimit(request);
    const { boundary, start, end, index } = validateRequest(await request.json());
    stage = 'initialize';
    const auth = await initializeGee();
    stage = 'geometry';
    const units = ee.FeatureCollection(boundary.features.map((feature) =>
      ee.Feature(geeGeometry(feature.geometry), feature.properties || {}),
    ));
    const region = units.geometry();
    const collection = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(region)
      .filterDate(start, end)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 60));
    stage = 'scene-count';
    const sceneCount = await evaluate<number>(collection.size());
    if (!sceneCount) throw new Error('所选时段没有满足条件的Sentinel-2影像，请扩大日期范围。');
    const composite = collection.median().clip(region);
    let image = composite;
    let bandIds = ['B4', 'B3', 'B2'];
    let visualizationOptions: Record<string, unknown> = { ranges: [{ min: 0, max: 3000 }], gamma: 1.15 };
    if (index === 'NDVI') {
      image = composite.normalizedDifference(['B8', 'B4']).rename('NDVI');
      bandIds = ['NDVI'];
      visualizationOptions = { ranges: [{ min: -0.3, max: 0.85 }], paletteColors: ['#7f3b08', '#f6e8c3', '#90c987', '#075c37'] };
    } else if (index === 'NDMI') {
      image = composite.normalizedDifference(['B8', 'B11']).rename('NDMI');
      bandIds = ['NDMI'];
      visualizationOptions = { ranges: [{ min: -0.5, max: 0.65 }], paletteColors: ['#8c510a', '#f6e8c3', '#80cdc1', '#01665e'] };
    } else if (index === 'MNDWI') {
      image = composite.normalizedDifference(['B3', 'B11']).rename('MNDWI');
      bandIds = ['MNDWI'];
      visualizationOptions = { ranges: [{ min: -0.6, max: 0.7 }], paletteColors: ['#a6611a', '#f5f5f5', '#4393c3', '#053061'] };
    }
    stage = 'image';
    const imageUrl = await computePng(image, auth, pixelGrid(boundsOf(boundary.features)), bandIds, visualizationOptions);
    let mean: number | null = null;
    if (index !== 'RGB') {
      stage = 'statistics';
      const stats = await evaluate<Record<string, unknown>>(image.reduceRegion({
        reducer: ee.Reducer.mean(), geometry: region, scale: 20, bestEffort: true, maxPixels: 1e9,
      }));
      mean = typeof stats[index] === 'number' ? stats[index] : null;
    }
    return Response.json({ imageUrl, index, sceneCount, mean, generatedAt: new Date().toISOString() });
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    console.error(`[GEE:${stage}] ${diagnostic.slice(0, 1200)}`);
    const [message, status] = publicError(error);
    return Response.json({ error: message }, { status });
  }
}
