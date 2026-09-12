import earthEngineModule from '@google/earthengine';
import { env } from 'cloudflare:workers';

type GeeIndex = 'RGB' | 'NDVI' | 'NDMI' | 'MNDWI';
type ServiceAccount = {
  type: 'service_account';
  project_id: string;
  client_email: string;
  private_key: string;
};
type UserOAuthCredentials = {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  scopes?: string[];
};
type RuntimeEnv = {
  GEE_SERVICE_ACCOUNT_JSON?: string;
  GEE_USER_CREDENTIALS_JSON?: string;
  GEE_CLOUD_PROJECT_ID?: string;
  GEE_LOCAL_BRIDGE_URL?: string;
};
type AuthConfig =
  | { kind: 'service_account'; projectId: string; credentials: ServiceAccount }
  | {
      kind: 'user_oauth';
      projectId: string;
      credentials: UserOAuthCredentials;
    };
type EeObject = { [key: string]: (...args: unknown[]) => EeObject };
type EeApi = {
  reset?: () => void;
  data: { setAuthToken: (...args: unknown[]) => void };
  initialize: (...args: unknown[]) => void;
  Geometry: {
    Polygon: (coordinates: unknown) => EeObject;
    MultiPolygon: (coordinates: unknown) => EeObject;
  };
  Feature: (
    geometry: EeObject | null,
    properties?: Record<string, unknown>,
  ) => EeObject;
  FeatureCollection: (value: unknown) => EeObject;
  Image: { (value?: unknown): EeObject; pixelArea: () => EeObject };
  ImageCollection: (assetId: string) => EeObject;
  Filter: { lt: (property: string, value: number) => unknown };
  Reducer: { mean: () => unknown; min: () => unknown; sum: () => unknown };
  Serializer: { encodeCloudApi: (value: EeObject) => Record<string, unknown> };
};

const ee = earthEngineModule as EeApi;
const requestBuckets = new Map<string, { count: number; resetAt: number }>();
const analysisCache = new Map<
  string,
  { expiresAt: number; payload: Record<string, unknown> }
>();
type GeeAuth = {
  token: string;
  projectId: string;
  expiresAt: number;
  authMode: AuthConfig['kind'];
};
let initialization: Promise<GeeAuth> | null = null;

function localBridgeUrl() {
  const value = (env as unknown as RuntimeEnv).GEE_LOCAL_BRIDGE_URL?.replace(
    /\/$/,
    '',
  );
  if (!value) return null;
  const parsed = new URL(value);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))
    throw new Error('GEE_LOCAL_BRIDGE_INVALID');
  return parsed.toString().replace(/\/$/, '');
}

async function bridgeRequest(path: string, init?: RequestInit) {
  const bridge = localBridgeUrl();
  if (!bridge) return null;
  return fetch(`${bridge}${path}`, {
    ...init,
    signal: AbortSignal.timeout(300_000),
  });
}

function readAuthConfig(): AuthConfig {
  const runtimeEnv = env as unknown as RuntimeEnv;
  if (runtimeEnv.GEE_SERVICE_ACCOUNT_JSON) {
    let key: Partial<ServiceAccount>;
    try {
      key = JSON.parse(
        runtimeEnv.GEE_SERVICE_ACCOUNT_JSON,
      ) as Partial<ServiceAccount>;
    } catch {
      throw new Error('GEE_SERVER_CREDENTIAL_INVALID');
    }
    if (
      key.type !== 'service_account' ||
      !key.project_id ||
      !key.client_email ||
      !key.private_key
    ) {
      throw new Error('GEE_SERVER_CREDENTIAL_INVALID');
    }
    return {
      kind: 'service_account',
      projectId: key.project_id,
      credentials: key as ServiceAccount,
    };
  }

  if (
    !runtimeEnv.GEE_USER_CREDENTIALS_JSON ||
    !runtimeEnv.GEE_CLOUD_PROJECT_ID
  ) {
    throw new Error('GEE_SERVER_NOT_CONFIGURED');
  }
  let credentials: Partial<UserOAuthCredentials>;
  try {
    credentials = JSON.parse(
      runtimeEnv.GEE_USER_CREDENTIALS_JSON,
    ) as Partial<UserOAuthCredentials>;
  } catch {
    throw new Error('GEE_USER_CREDENTIAL_INVALID');
  }
  if (
    !credentials.client_id ||
    !credentials.client_secret ||
    !credentials.refresh_token
  ) {
    throw new Error('GEE_USER_CREDENTIAL_INVALID');
  }
  return {
    kind: 'user_oauth',
    projectId: runtimeEnv.GEE_CLOUD_PROJECT_ID,
    credentials: credentials as UserOAuthCredentials,
  };
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
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
    scope:
      'https://www.googleapis.com/auth/earthengine https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const unsigned = `${header}.${claims}`;
  const der = Uint8Array.from(
    atob(
      key.private_key.replace(
        /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,
        '',
      ),
    ),
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
  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token)
    throw new Error(payload.error_description || 'GEE_TOKEN_FAILED');
  return { token: payload.access_token, expiresIn: payload.expires_in || 3600 };
}

async function userAccountToken(key: UserOAuthCredentials) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: key.refresh_token,
    }),
  });
  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(
      `GEE_USER_TOKEN_FAILED: ${payload.error_description || payload.error || 'unknown error'}`,
    );
  }
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
      const config = readAuthConfig();
      const { token, expiresIn } =
        config.kind === 'service_account'
          ? await serviceAccountToken(config.credentials)
          : await userAccountToken(config.credentials);
      const clientId =
        config.kind === 'service_account'
          ? config.credentials.client_email
          : config.credentials.client_id;
      const scopes =
        config.kind === 'user_oauth' && config.credentials.scopes?.length
          ? config.credentials.scopes
          : [
              'https://www.googleapis.com/auth/earthengine',
              'https://www.googleapis.com/auth/cloud-platform',
            ];
      ee.reset?.();
      await new Promise<void>((resolve, reject) => {
        ee.data.setAuthToken(
          clientId,
          'Bearer',
          token,
          expiresIn,
          scopes,
          () =>
            ee.initialize(null, null, resolve, reject, null, config.projectId),
          false,
          true,
        );
      });
      return {
        token,
        projectId: config.projectId,
        expiresAt: Date.now() + Math.max(expiresIn - 60, 60) * 1000,
        authMode: config.kind,
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
    object.evaluate((value: unknown, error: unknown) =>
      error ? reject(error) : resolve(value as T),
    );
  });
}

function boundsOf(features: Array<{ geometry?: unknown }>) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number'
    ) {
      minX = Math.min(minX, value[0]);
      minY = Math.min(minY, value[1]);
      maxX = Math.max(maxX, value[0]);
      maxY = Math.max(maxY, value[1]);
      return;
    }
    value.forEach(walk);
  };
  features.forEach((feature) =>
    walk((feature.geometry as { coordinates?: unknown })?.coordinates),
  );
  if (
    ![minX, minY, maxX, maxY].every(Number.isFinite) ||
    minX < -180 ||
    maxX > 180 ||
    minY < -90 ||
    maxY > 90
  ) {
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
  const displayRatio =
    ((maxX - minX) * Math.max(Math.cos((latitude * Math.PI) / 180), 0.15)) /
    (maxY - minY);
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

function adaptiveScale(bounds: ReturnType<typeof boundsOf>) {
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  if (span <= 1) return 20;
  if (span <= 3) return 100;
  if (span <= 8) return 250;
  return 500;
}

function pngDataUrl(bytes: ArrayBuffer) {
  const data = new Uint8Array(bytes);
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 100_000) / 100_000
    : null;
}

async function cacheKey(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function cacheResult(key: string, payload: Record<string, unknown>) {
  const now = Date.now();
  for (const [existingKey, item] of analysisCache) {
    if (item.expiresAt <= now) analysisCache.delete(existingKey);
  }
  if (analysisCache.size >= 4) {
    const oldest = analysisCache.keys().next().value;
    if (oldest) analysisCache.delete(oldest);
  }
  analysisCache.set(key, { expiresAt: now + 15 * 60_000, payload });
}

function jsonWithTrace(
  payload: unknown,
  status: number,
  requestId: string,
  cacheStatus?: 'HIT' | 'MISS',
) {
  const headers = new Headers({ 'x-request-id': requestId });
  if (cacheStatus) headers.set('x-analysis-cache', cacheStatus);
  return Response.json(payload, { status, headers });
}

function seasonalWindow(year: number, start: string, end: string) {
  const sourceStart = new Date(`${start}T00:00:00Z`);
  const durationMs = Date.parse(end) - Date.parse(start);
  const day =
    sourceStart.getUTCMonth() === 1 && sourceStart.getUTCDate() === 29
      ? 28
      : sourceStart.getUTCDate();
  const shiftedStart = new Date(Date.UTC(year, sourceStart.getUTCMonth(), day));
  const shiftedEnd = new Date(shiftedStart.getTime() + durationMs);
  return {
    start: shiftedStart.toISOString().slice(0, 10),
    end: shiftedEnd.toISOString().slice(0, 10),
  };
}

async function computeContextEvidence(
  region: EeObject,
  start: string,
  end: string,
  sceneCount: number,
  unitMetrics: Array<{
    areaM2: number | null;
    candidateWetlandAreaM2: number | null;
    validFraction: number | null;
    waterAreaM2: number | null;
  }>,
  candidateWetland: EeObject,
  analysisScale: number,
) {
  const era5 = ee
    .ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR')
    .filterDate(start, end);
  const climateImage = era5
    .select('total_precipitation_sum')
    .sum()
    .multiply(1000)
    .max(0)
    .rename('precipitation_mm')
    .addBands(
      era5
        .select('potential_evaporation_sum')
        .sum()
        .multiply(-1000)
        .max(0)
        .rename('potential_evaporation_mm'),
    )
    .addBands(
      era5.select('runoff_sum').sum().multiply(1000).max(0).rename('runoff_mm'),
    )
    .addBands(
      era5.select('volumetric_soil_water_layer_1').mean().rename('soil_water'),
    );
  const climateStatsPromise = evaluate<Record<string, unknown>>(
    climateImage.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: region,
      scale: 11132,
      bestEffort: true,
      maxPixels: 1e8,
    }),
  );
  const historicalWater = ee
    .Image('JRC/GSW1_4/GlobalSurfaceWater')
    .select(['occurrence', 'seasonality']);
  const waterStatsPromise = evaluate<Record<string, unknown>>(
    historicalWater.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: region,
      scale: 30,
      bestEffort: true,
      maxPixels: 1e8,
    }),
  );

  const startYear = Number(start.slice(0, 4));
  const annualFeatures: EeObject[] = [];
  for (let year = Math.max(2017, startYear - 4); year <= startYear; year += 1) {
    const window = seasonalWindow(year, start, end);
    const yearly = ee
      .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(region)
      .filterDate(window.start, window.end)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 80))
      .map((candidate: unknown) => {
        const source = candidate as EeObject;
        const scl = source.select('SCL');
        const clear = scl
          .neq(0)
          .and(scl.neq(1))
          .and(scl.neq(3))
          .and(scl.neq(8))
          .and(scl.neq(9))
          .and(scl.neq(10))
          .and(scl.neq(11));
        return source
          .select(['B2', 'B3', 'B4', 'B8', 'B11'])
          .multiply(0.0001)
          .updateMask(clear);
      });
    const composite = yearly.median();
    const yearlyMetrics = composite
      .normalizedDifference(['B8', 'B4'])
      .rename('NDVI')
      .addBands(composite.normalizedDifference(['B8', 'B11']).rename('NDMI'))
      .addBands(composite.normalizedDifference(['B3', 'B11']).rename('MNDWI'))
      .updateMask(candidateWetland);
    const stats = yearlyMetrics.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: region,
      scale: analysisScale,
      bestEffort: true,
      maxPixels: 1e9,
    });
    annualFeatures.push(
      ee
        .Feature(null, stats as unknown as Record<string, unknown>)
        .set('year', year)
        .set('start', window.start)
        .set('end', window.end)
        .set('sceneCount', yearly.size()),
    );
  }
  const seriesResultPromise = evaluate<{
    features?: Array<{ properties?: Record<string, unknown> }>;
  }>(ee.FeatureCollection(annualFeatures));
  const [climateStats, waterStats, seriesResult] = await Promise.all([
    climateStatsPromise,
    waterStatsPromise,
    seriesResultPromise,
  ]);
  const annualSeries = (seriesResult.features || []).map((feature) => {
    const properties = feature.properties || {};
    const rowStart =
      typeof properties.start === 'string' ? properties.start : '';
    const rowEnd = typeof properties.end === 'string' ? properties.end : '';
    return {
      year: Number(properties.year),
      start: rowStart,
      end: rowEnd,
      sceneCount: Number(properties.sceneCount || 0),
      ndvi: finiteNumber(properties.NDVI),
      ndmi: finiteNumber(properties.NDMI),
      mndwi: finiteNumber(properties.MNDWI),
    };
  });

  const precipitation = finiteNumber(climateStats.precipitation_mm);
  const potentialEvaporation = finiteNumber(
    climateStats.potential_evaporation_mm,
  );
  const runoff = finiteNumber(climateStats.runoff_mm);
  const occurrence = finiteNumber(waterStats.occurrence);
  const totalArea = unitMetrics.reduce(
    (sum, unit) => sum + (unit.candidateWetlandAreaM2 || 0),
    0,
  );
  const recentWaterFraction = totalArea
    ? Math.min(
        1,
        unitMetrics.reduce((sum, unit) => sum + (unit.waterAreaM2 || 0), 0) /
          totalArea,
      )
    : null;
  const history = annualSeries
    .slice(0, -1)
    .map((row) => row.ndmi)
    .filter((value): value is number => value !== null);
  const currentNdmi = annualSeries.at(-1)?.ndmi ?? null;
  const historyMean = history.length
    ? history.reduce((sum, value) => sum + value, 0) / history.length
    : null;
  const historyStd =
    historyMean === null
      ? null
      : Math.sqrt(
          history.reduce((sum, value) => sum + (value - historyMean) ** 2, 0) /
            history.length,
        );
  const ndmiAnomalyZ =
    currentNdmi !== null &&
    historyMean !== null &&
    historyStd !== null &&
    historyStd > 1e-6
      ? Math.round(((currentNdmi - historyMean) / historyStd) * 1000) / 1000
      : null;
  const coverages = unitMetrics
    .map((unit) => unit.validFraction)
    .filter((value): value is number => value !== null);
  const meanValidCoverage = coverages.length
    ? coverages.reduce((sum, value) => sum + value, 0) / coverages.length
    : 0;
  const confidence =
    sceneCount >= 5 && meanValidCoverage >= 0.8 && history.length >= 3
      ? 'high'
      : sceneCount >= 3 && meanValidCoverage >= 0.6 && history.length >= 2
        ? 'medium'
        : 'low';
  const floodPressureScore =
    Math.round(
      1000 *
        (0.45 * Math.min(1, (recentWaterFraction || 0) / 0.3) +
          0.35 * Math.min(1, (runoff || 0) / 50) +
          0.2 * Math.min(1, (occurrence || 0) / 100)),
    ) / 10;

  return {
    climate: {
      precipitationMm: precipitation,
      potentialEvaporationMm: potentialEvaporation,
      waterBalanceMm:
        precipitation !== null && potentialEvaporation !== null
          ? Math.round((precipitation - potentialEvaporation) * 100) / 100
          : null,
      runoffMm: runoff,
      soilWaterM3m3: finiteNumber(climateStats.soil_water),
      source: 'ECMWF/ERA5_LAND/DAILY_AGGR',
      scaleM: 11132,
    },
    waterBaseline: {
      occurrencePct: occurrence,
      seasonalityMonths: finiteNumber(waterStats.seasonality),
      recentWaterFraction,
      source: 'JRC/GSW1_4/GlobalSurfaceWater',
      scaleM: 30,
    },
    floodPressureScore,
    annualSeries,
    uncertainty: {
      confidence,
      meanValidCoverage,
      historicalYears: history.length,
      ndmiHistoricalMean: finiteNumber(historyMean),
      ndmiHistoricalStd: finiteNumber(historyStd),
      ndmiAnomalyZ,
    },
    methodNote:
      '气候量为ERA5-Land研究区均值；洪水压力是近期水面、径流和历史水面频率的筛查分，不等同于水动力洪水风险。',
  };
}

function textValue(values: unknown[], fallback: string) {
  const value = values.find(
    (candidate) =>
      typeof candidate === 'string' || typeof candidate === 'number',
  );
  return value === undefined ? fallback : String(value);
}

async function computePng(
  image: EeObject,
  auth: GeeAuth,
  grid: ReturnType<typeof pixelGrid>,
  bandIds: string[],
  visualizationOptions: Record<string, unknown>,
) {
  const response = await fetch(
    `https://earthengine.googleapis.com/v1/projects/${encodeURIComponent(auth.projectId)}/image:computePixels`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expression: ee.Serializer.encodeCloudApi(image),
        fileFormat: 'PNG',
        grid,
        bandIds,
        visualizationOptions,
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `GEE_COMPUTE_PIXELS_${response.status}: ${detail.slice(0, 1000)}`,
    );
  }
  return pngDataUrl(await response.arrayBuffer());
}

function validateRequest(payload: unknown) {
  if (!payload || typeof payload !== 'object')
    throw new Error('请求内容无效。');
  const input = payload as {
    boundary?: unknown;
    start?: unknown;
    end?: unknown;
    index?: unknown;
  };
  const boundary = input.boundary as {
    type?: unknown;
    features?: Array<{
      geometry?: unknown;
      properties?: Record<string, unknown>;
    }>;
  };
  if (
    boundary?.type !== 'FeatureCollection' ||
    !Array.isArray(boundary.features) ||
    boundary.features.length < 1 ||
    boundary.features.length > 150
  ) {
    throw new Error('研究区必须包含1—150个面要素。');
  }
  const features = boundary.features;
  const text = JSON.stringify(boundary);
  if (text.length > 1_900_000)
    throw new Error('研究区边界过于复杂，请先简化边界。');
  const start = typeof input.start === 'string' ? input.start : '';
  const end = typeof input.end === 'string' ? input.end : '';
  const index = input.index as GeeIndex;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
    start >= end
  )
    throw new Error('分析日期无效。');
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (days > 366) throw new Error('单次分析时间范围不能超过366天。');
  if (!['RGB', 'NDVI', 'NDMI', 'MNDWI'].includes(index))
    throw new Error('分析指标无效。');
  return {
    boundary: { type: 'FeatureCollection' as const, features },
    start,
    end,
    index,
  };
}

function checkRateLimit(request: Request) {
  const key = request.headers.get('cf-connecting-ip') || 'local';
  const now = Date.now();
  for (const [existingKey, bucket] of requestBuckets) {
    if (bucket.resetAt < now) requestBuckets.delete(existingKey);
  }
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
  if (geometry?.type === 'Polygon')
    return ee.Geometry.Polygon(geometry.coordinates);
  if (geometry?.type === 'MultiPolygon')
    return ee.Geometry.MultiPolygon(geometry.coordinates);
  throw new Error('研究区只能包含Polygon或MultiPolygon面要素。');
}

function publicError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('GEE_SERVER_NOT_CONFIGURED'))
    return ['网站的GEE服务账号尚未配置。', 503] as const;
  if (message.includes('GEE_SERVER_CREDENTIAL_INVALID'))
    return ['网站的GEE服务账号密钥无效。', 503] as const;
  if (message.includes('GEE_USER_CREDENTIAL_INVALID'))
    return ['本地GEE用户凭据格式无效。', 503] as const;
  if (message.includes('GEE_USER_TOKEN_FAILED'))
    return ['GEE用户授权已失效，请重新登录授权。', 503] as const;
  if (message.includes('GEE_LOCAL_BRIDGE_INVALID'))
    return ['本地GEE桥接地址无效。', 503] as const;
  if (message.includes('RATE_LIMITED'))
    return ['当前设备请求过于频繁，请稍后再试。', 429] as const;
  if (/permission|403|not registered|not authorized/i.test(message))
    return [
      'GEE项目权限不足，请检查服务账号角色和项目注册状态。',
      502,
    ] as const;
  return [message || 'GEE分析失败。', 500] as const;
}

export async function GET() {
  try {
    const bridgeResponse = await bridgeRequest('/health');
    if (bridgeResponse) {
      const payload = await bridgeResponse.json();
      return Response.json(payload, { status: bridgeResponse.status });
    }
    const auth = await initializeGee();
    return Response.json({
      configured: true,
      projectId: auth.projectId,
      authMode: auth.authMode,
    });
  } catch (error) {
    const [message, status] = publicError(error);
    return Response.json({ configured: false, error: message }, { status });
  }
}

export async function POST(request: Request) {
  let stage = 'request';
  const requestId = crypto.randomUUID();
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 2_200_000)
      return jsonWithTrace({ error: '研究区文件过大。' }, 413, requestId);
    checkRateLimit(request);
    const validated = validateRequest(await request.json());
    const { boundary, start, end, index } = validated;
    const resultCacheKey = await cacheKey(validated);
    const cached = analysisCache.get(resultCacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return jsonWithTrace(cached.payload, 200, requestId, 'HIT');
    }
    const bridgeResponse = await bridgeRequest('/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ boundary, start, end, index }),
    });
    if (bridgeResponse) {
      const payload = (await bridgeResponse.json()) as Record<string, unknown>;
      if (bridgeResponse.ok) cacheResult(resultCacheKey, payload);
      return jsonWithTrace(payload, bridgeResponse.status, requestId, 'MISS');
    }
    stage = 'initialize';
    const auth = await initializeGee();
    stage = 'geometry';
    const units = ee.FeatureCollection(
      boundary.features.map((feature) =>
        ee.Feature(geeGeometry(feature.geometry), feature.properties || {}),
      ),
    );
    const region = units.geometry();
    const bounds = boundsOf(boundary.features);
    const analysisScale = adaptiveScale(bounds);
    const sourceCollection = ee
      .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(region)
      .filterDate(start, end)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 80));
    const collection = sourceCollection.map((candidate: unknown) => {
      const source = candidate as EeObject;
      const scl = source.select('SCL');
      const clear = scl
        .neq(0)
        .and(scl.neq(1))
        .and(scl.neq(3))
        .and(scl.neq(8))
        .and(scl.neq(9))
        .and(scl.neq(10))
        .and(scl.neq(11));
      return source
        .select(['B2', 'B3', 'B4', 'B8', 'B11'])
        .multiply(0.0001)
        .updateMask(clear)
        .copyProperties(source, ['system:time_start', 'system:index']);
    });
    stage = 'scene-count';
    const sceneCount = await evaluate<number>(collection.size());
    if (!sceneCount)
      throw new Error('所选时段没有满足条件的Sentinel-2影像，请扩大日期范围。');
    const composite = collection.median();
    const ndvi = composite.normalizedDifference(['B8', 'B4']).rename('NDVI');
    const ndmi = composite.normalizedDifference(['B8', 'B11']).rename('NDMI');
    const mndwi = composite.normalizedDifference(['B3', 'B11']).rename('MNDWI');
    const metrics = ndvi.addBands(ndmi).addBands(mndwi);
    const jrc = ee.Image('JRC/GSW1_4/GlobalSurfaceWater');
    const dynamicWorld = ee
      .ImageCollection('GOOGLE/DYNAMICWORLD/V1')
      .filterBounds(region)
      .filterDate(start, end)
      .select(['water', 'flooded_vegetation'])
      .mean();
    const candidateWetland = jrc
      .select('occurrence')
      .gt(5)
      .or(
        dynamicWorld
          .select('water')
          .max(dynamicWorld.select('flooded_vegetation'))
          .gt(0.25),
      )
      .rename('candidate_wetland');
    const candidateMask = candidateWetland.unmask(0);
    const merit = ee.Image('MERIT/Hydro/v1_0_1');
    const lowHand = ee
      .Image(1)
      .subtract(merit.select('hnd').clamp(0, 10).divide(10));
    const potentialAccess = lowHand
      .multiply(0.65)
      .add(
        jrc
          .select('occurrence')
          .unmask(0)
          .divide(100)
          .clamp(0, 1)
          .multiply(0.35),
      )
      .multiply(100)
      .rename('potential_access');
    let image = composite;
    let bandIds = ['B4', 'B3', 'B2'];
    let visualizationOptions: Record<string, unknown> = {
      ranges: [{ min: 0, max: 0.3 }],
      gamma: 1.15,
    };
    if (index === 'NDVI') {
      image = ndvi;
      bandIds = ['NDVI'];
      visualizationOptions = {
        ranges: [{ min: -0.3, max: 0.85 }],
        paletteColors: ['#7f3b08', '#f6e8c3', '#90c987', '#075c37'],
      };
    } else if (index === 'NDMI') {
      image = ndmi;
      bandIds = ['NDMI'];
      visualizationOptions = {
        ranges: [{ min: -0.5, max: 0.65 }],
        paletteColors: ['#8c510a', '#f6e8c3', '#80cdc1', '#01665e'],
      };
    } else if (index === 'MNDWI') {
      image = mndwi;
      bandIds = ['MNDWI'];
      visualizationOptions = {
        ranges: [{ min: -0.6, max: 0.7 }],
        paletteColors: ['#a6611a', '#f5f5f5', '#4393c3', '#053061'],
      };
    }
    stage = 'image';
    const imageUrl = await computePng(
      image,
      auth,
      pixelGrid(bounds),
      bandIds,
      visualizationOptions,
    );
    let mean: number | null = null;
    if (index !== 'RGB') {
      stage = 'statistics';
      const stats = await evaluate<Record<string, unknown>>(
        image.reduceRegion({
          reducer: ee.Reducer.mean(),
          geometry: region,
          scale: analysisScale,
          bestEffort: true,
          maxPixels: 1e9,
        }),
      );
      mean = typeof stats[index] === 'number' ? stats[index] : null;
    }
    stage = 'unit-statistics';
    const valid = metrics.mask().reduce(ee.Reducer.min()).rename('valid');
    const water = mndwi.gt(0).and(ndvi.lt(0.3)).rename('water');
    const pixelArea = ee.Image.pixelArea();
    const areaBands = pixelArea
      .rename('pixel_area_m2')
      .addBands(
        pixelArea.multiply(candidateMask).rename('candidate_wetland_area_m2'),
      )
      .addBands(
        pixelArea
          .multiply(candidateMask)
          .multiply(valid.unmask(0))
          .rename('valid_area_m2'),
      )
      .addBands(
        pixelArea
          .multiply(water.unmask(0))
          .multiply(valid.unmask(0))
          .multiply(candidateMask)
          .rename('water_area_m2'),
      );
    const combinedReducer = (ee.Reducer.mean() as EeObject).combine({
      reducer2: ee.Reducer.sum(),
      sharedInputs: true,
    });
    const reduced = await evaluate<{
      features?: Array<{ properties?: Record<string, unknown> }>;
    }>(
      metrics
        .updateMask(candidateWetland)
        .addBands(potentialAccess.updateMask(candidateWetland))
        .addBands(
          merit.select('hnd').rename('hand_m').updateMask(candidateWetland),
        )
        .addBands(areaBands)
        .reduceRegions({
          collection: units,
          reducer: combinedReducer,
          scale: analysisScale,
          tileScale: 4,
        }),
    );
    const unitMetrics = (reduced.features || []).map((feature, position) => {
      const properties = feature.properties || {};
      const source = boundary.features[position]?.properties || {};
      const areaM2 = finiteNumber(properties.pixel_area_m2_sum);
      const validAreaM2 = finiteNumber(properties.valid_area_m2_sum);
      const candidateWetlandAreaM2 = finiteNumber(
        properties.candidate_wetland_area_m2_sum,
      );
      return {
        id: textValue([source.id, properties.id], `U${position + 1}`),
        name: textValue(
          [source.name, properties.name, source.id],
          `单元${position + 1}`,
        ),
        areaM2,
        validFraction:
          candidateWetlandAreaM2 && validAreaM2 !== null
            ? Math.round(
                Math.min(1, validAreaM2 / candidateWetlandAreaM2) * 10_000,
              ) / 10_000
            : null,
        waterAreaM2: finiteNumber(properties.water_area_m2_sum),
        candidateWetlandAreaM2,
        candidateWetlandFraction:
          areaM2 && candidateWetlandAreaM2 !== null
            ? Math.round(
                Math.min(1, candidateWetlandAreaM2 / areaM2) * 100_000,
              ) / 100_000
            : null,
        accessibilityScore: finiteNumber(properties.potential_access_mean),
        meanHandM: finiteNumber(properties.hand_m_mean),
        ndvi: finiteNumber(properties.NDVI_mean),
        ndmi: finiteNumber(properties.NDMI_mean),
        mndwi: finiteNumber(properties.MNDWI_mean),
      };
    });
    stage = 'context-evidence';
    const context = await computeContextEvidence(
      region,
      start,
      end,
      sceneCount,
      unitMetrics,
      candidateWetland,
      analysisScale,
    );
    const result = {
      imageUrl,
      index,
      sceneCount,
      mean,
      unitMetrics,
      generatedAt: new Date().toISOString(),
      projectId: auth.projectId,
      dataSource: 'COPERNICUS/S2_SR_HARMONIZED',
      scaleM: analysisScale,
      qualityNote: `已使用SCL剔除云、云影和雪像元；当前为${analysisScale} m自适应统计尺度。湿地候选区由JRC历史水面和Dynamic World水体/淹水植被概率联合筛选。`,
      context,
    };
    cacheResult(resultCacheKey, result);
    return jsonWithTrace(result, 200, requestId, 'MISS');
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    console.error(`[GEE:${stage}] ${diagnostic.slice(0, 1200)}`);
    const [message, status] = publicError(error);
    return jsonWithTrace({ error: message }, status, requestId);
  }
}
