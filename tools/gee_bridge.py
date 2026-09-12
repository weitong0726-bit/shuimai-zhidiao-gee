#!/usr/bin/env python3
"""Local-only Earth Engine bridge for researchers using saved user OAuth credentials.

The browser never receives refresh tokens. Production deployments should use the
service-account path in app/api/gee/route.ts instead of exposing this bridge.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import math
import os
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import ee


MAX_BODY_BYTES = 2_000_000
PROJECT_ID = ''
INITIALIZED = False


def project_from_dev_vars() -> str:
    """Read the non-secret Cloud project id without exporting shell variables."""
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), '.dev.vars')
    try:
        with open(path, encoding='utf-8') as stream:
            for line in stream:
                if line.strip().startswith('GEE_CLOUD_PROJECT_ID='):
                    return line.split('=', 1)[1].strip().strip('"\'')
    except OSError:
        pass
    return ''


def initialize() -> None:
    global INITIALIZED
    if INITIALIZED:
        return
    credentials = ee.data.get_persistent_credentials()
    ee.Initialize(credentials=credentials, project=PROJECT_ID)
    INITIALIZED = True


def validate_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError('请求内容无效。')
    boundary = payload.get('boundary')
    if not isinstance(boundary, dict) or boundary.get('type') != 'FeatureCollection':
        raise ValueError('研究区必须是FeatureCollection。')
    features = boundary.get('features')
    if not isinstance(features, list) or not 1 <= len(features) <= 100:
        raise ValueError('研究区必须包含1—100个面要素。')
    start, end = payload.get('start', ''), payload.get('end', '')
    index = payload.get('index', '')
    if not isinstance(start, str) or not isinstance(end, str) or len(start) != 10 or len(end) != 10 or start >= end:
        raise ValueError('分析日期无效。')
    if index not in ('RGB', 'NDVI', 'NDMI', 'MNDWI'):
        raise ValueError('分析指标无效。')
    return {'boundary': boundary, 'features': features, 'start': start, 'end': end, 'index': index}


def prepare_sentinel(image: ee.Image) -> ee.Image:
    scl = image.select('SCL')
    clear = (
        scl.neq(0).And(scl.neq(1)).And(scl.neq(3)).And(scl.neq(8))
        .And(scl.neq(9)).And(scl.neq(10)).And(scl.neq(11))
    )
    bands = image.select(['B2', 'B3', 'B4', 'B8', 'B11']).multiply(0.0001).updateMask(clear)
    return bands.copyProperties(image, ['system:time_start', 'system:index'])


def finite_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return round(float(value), 5)
    return None


def seasonal_window(year: int, start: str, end: str) -> tuple[str, str]:
    start_date = dt.date.fromisoformat(start)
    end_date = dt.date.fromisoformat(end)
    duration = end_date - start_date
    try:
        shifted_start = start_date.replace(year=year)
    except ValueError:
        shifted_start = start_date.replace(year=year, day=28)
    return shifted_start.isoformat(), (shifted_start + duration).isoformat()


def context_evidence(
    region: ee.Geometry,
    request: dict[str, Any],
    scene_count: int,
    unit_metrics: list[dict[str, Any]],
) -> dict[str, Any]:
    era5 = ee.ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR').filterDate(
        request['start'], request['end']
    )
    climate_image = (
        era5.select('total_precipitation_sum').sum().multiply(1000).max(0).rename('precipitation_mm')
        .addBands(era5.select('potential_evaporation_sum').sum().multiply(-1000).max(0).rename('potential_evaporation_mm'))
        .addBands(era5.select('runoff_sum').sum().multiply(1000).max(0).rename('runoff_mm'))
        .addBands(era5.select('volumetric_soil_water_layer_1').mean().rename('soil_water'))
    )
    climate_stats = climate_image.reduceRegion(
        reducer=ee.Reducer.mean(), geometry=region, scale=11132,
        bestEffort=True, maxPixels=100_000_000,
    ).getInfo()
    precipitation = finite_number(climate_stats.get('precipitation_mm'))
    potential_evaporation = finite_number(climate_stats.get('potential_evaporation_mm'))
    runoff = finite_number(climate_stats.get('runoff_mm'))
    soil_water = finite_number(climate_stats.get('soil_water'))

    historical_water = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').select(['occurrence', 'seasonality'])
    water_stats = historical_water.reduceRegion(
        reducer=ee.Reducer.mean(), geometry=region, scale=30,
        bestEffort=True, maxPixels=100_000_000,
    ).getInfo()
    occurrence = finite_number(water_stats.get('occurrence'))
    seasonality = finite_number(water_stats.get('seasonality'))
    total_area = sum(metric.get('areaM2') or 0 for metric in unit_metrics)
    recent_water_area = sum(metric.get('waterAreaM2') or 0 for metric in unit_metrics)
    recent_water_fraction = round(min(1, recent_water_area / total_area), 5) if total_area else None

    start_year = dt.date.fromisoformat(request['start']).year
    series_features = []
    for year in range(max(2017, start_year - 4), start_year + 1):
        year_start, year_end = seasonal_window(year, request['start'], request['end'])
        yearly = (
            ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
            .filterBounds(region)
            .filterDate(year_start, year_end)
            .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', 80))
            .map(prepare_sentinel)
        )
        yearly_composite = yearly.median()
        yearly_metrics = (
            yearly_composite.normalizedDifference(['B8', 'B4']).rename('NDVI')
            .addBands(yearly_composite.normalizedDifference(['B8', 'B11']).rename('NDMI'))
            .addBands(yearly_composite.normalizedDifference(['B3', 'B11']).rename('MNDWI'))
        )
        stats = yearly_metrics.reduceRegion(
            reducer=ee.Reducer.mean(), geometry=region, scale=20,
            bestEffort=True, maxPixels=1_000_000_000,
        )
        series_features.append(
            ee.Feature(None, stats)
            .set('year', year)
            .set('start', year_start)
            .set('end', year_end)
            .set('sceneCount', yearly.size())
        )
    series_info = ee.FeatureCollection(series_features).getInfo()
    annual_series = []
    for feature in series_info.get('features', []):
        props = feature.get('properties', {})
        annual_series.append({
            'year': int(props.get('year')),
            'start': props.get('start'),
            'end': props.get('end'),
            'sceneCount': int(props.get('sceneCount') or 0),
            'ndvi': finite_number(props.get('NDVI')),
            'ndmi': finite_number(props.get('NDMI')),
            'mndwi': finite_number(props.get('MNDWI')),
        })

    history = [row['ndmi'] for row in annual_series[:-1] if row['ndmi'] is not None]
    current_ndmi = annual_series[-1]['ndmi'] if annual_series else None
    history_mean = sum(history) / len(history) if history else None
    history_std = (
        math.sqrt(sum((value - history_mean) ** 2 for value in history) / len(history))
        if history_mean is not None and history else None
    )
    anomaly_z = (
        round((current_ndmi - history_mean) / history_std, 3)
        if current_ndmi is not None and history_mean is not None and history_std and history_std > 1e-6
        else None
    )
    coverages = [metric['validFraction'] for metric in unit_metrics if metric.get('validFraction') is not None]
    mean_coverage = sum(coverages) / len(coverages) if coverages else 0
    if scene_count >= 5 and mean_coverage >= 0.8 and len(history) >= 3:
        confidence = 'high'
    elif scene_count >= 3 and mean_coverage >= 0.6 and len(history) >= 2:
        confidence = 'medium'
    else:
        confidence = 'low'

    flood_pressure = round(
        100 * (
            0.45 * min(1, (recent_water_fraction or 0) / 0.30)
            + 0.35 * min(1, (runoff or 0) / 50)
            + 0.20 * min(1, (occurrence or 0) / 100)
        ), 1
    )
    return {
        'climate': {
            'precipitationMm': precipitation,
            'potentialEvaporationMm': potential_evaporation,
            'waterBalanceMm': round(precipitation - potential_evaporation, 2)
            if precipitation is not None and potential_evaporation is not None else None,
            'runoffMm': runoff,
            'soilWaterM3m3': soil_water,
            'source': 'ECMWF/ERA5_LAND/DAILY_AGGR',
            'scaleM': 11132,
        },
        'waterBaseline': {
            'occurrencePct': occurrence,
            'seasonalityMonths': seasonality,
            'recentWaterFraction': recent_water_fraction,
            'source': 'JRC/GSW1_4/GlobalSurfaceWater',
            'scaleM': 30,
        },
        'floodPressureScore': flood_pressure,
        'annualSeries': annual_series,
        'uncertainty': {
            'confidence': confidence,
            'meanValidCoverage': round(mean_coverage, 4),
            'historicalYears': len(history),
            'ndmiHistoricalMean': finite_number(history_mean),
            'ndmiHistoricalStd': finite_number(history_std),
            'ndmiAnomalyZ': anomaly_z,
        },
        'methodNote': '气候量为ERA5-Land研究区均值；洪水压力是近期水面、径流和历史水面频率的筛查分，不等同于水动力洪水风险。',
    }


def analyze(payload: Any) -> dict[str, Any]:
    request = validate_payload(payload)
    initialize()
    units = ee.FeatureCollection(request['boundary'])
    region = units.geometry()
    collection = (
        ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(request['start'], request['end'])
        .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', 80))
        .map(prepare_sentinel)
    )
    scene_count = int(collection.size().getInfo())
    if scene_count < 1:
        raise ValueError('所选时段没有满足条件的Sentinel-2影像，请扩大日期范围。')

    # Keep surrounding context visible in the thumbnail; all statistics remain
    # restricted to the uploaded management units below.
    composite = collection.median()
    ndvi = composite.normalizedDifference(['B8', 'B4']).rename('NDVI')
    ndmi = composite.normalizedDifference(['B8', 'B11']).rename('NDMI')
    mndwi = composite.normalizedDifference(['B3', 'B11']).rename('MNDWI')
    metrics = ndvi.addBands(ndmi).addBands(mndwi)

    valid = metrics.mask().reduce(ee.Reducer.min()).rename('valid')
    water = mndwi.gt(0).And(ndvi.lt(0.3)).rename('water')
    area_bands = (
        ee.Image.pixelArea().rename('pixel_area_m2')
        .addBands(ee.Image.pixelArea().multiply(valid.unmask(0)).rename('valid_area_m2'))
        .addBands(ee.Image.pixelArea().multiply(water.updateMask(valid).unmask(0)).rename('water_area_m2'))
    )
    analysis_image = metrics.addBands(area_bands)
    reduced = analysis_image.reduceRegions(
        collection=units,
        reducer=ee.Reducer.mean().combine(ee.Reducer.sum(), sharedInputs=True),
        scale=20,
        tileScale=4,
    ).getInfo()

    unit_metrics: list[dict[str, Any]] = []
    for position, feature in enumerate(reduced.get('features', [])):
        properties = feature.get('properties', {})
        source = request['features'][position].get('properties', {}) if position < len(request['features']) else {}
        area_m2 = finite_number(properties.get('pixel_area_m2_sum'))
        valid_area_m2 = finite_number(properties.get('valid_area_m2_sum'))
        unit_metrics.append({
            'id': str(source.get('id') or properties.get('id') or f'U{position + 1}'),
            'name': str(source.get('name') or properties.get('name') or source.get('id') or f'单元{position + 1}'),
            'areaM2': area_m2,
            'validFraction': round(min(1.0, valid_area_m2 / area_m2), 4) if area_m2 and valid_area_m2 is not None else None,
            'waterAreaM2': finite_number(properties.get('water_area_m2_sum')),
            'ndvi': finite_number(properties.get('NDVI_mean')),
            'ndmi': finite_number(properties.get('NDMI_mean')),
            'mndwi': finite_number(properties.get('MNDWI_mean')),
        })

    selected = {'RGB': composite, 'NDVI': ndvi, 'NDMI': ndmi, 'MNDWI': mndwi}[request['index']]
    visual = {
        'RGB': {'bands': ['B4', 'B3', 'B2'], 'min': 0, 'max': 0.3},
        'NDVI': {'min': -0.3, 'max': 0.85, 'palette': ['7f3b08', 'f6e8c3', '90c987', '075c37']},
        'NDMI': {'min': -0.5, 'max': 0.65, 'palette': ['8c510a', 'f6e8c3', '80cdc1', '01665e']},
        'MNDWI': {'min': -0.6, 'max': 0.7, 'palette': ['a6611a', 'f5f5f5', '4393c3', '053061']},
    }[request['index']]
    outline = ee.Image().byte().paint(units, 1, 2).selfMask().visualize(palette=['f0c85f'])
    display = selected.visualize(**visual).blend(outline)
    thumb_url = display.getThumbURL({
        'region': region.bounds(1).getInfo()['coordinates'],
        'dimensions': 1200,
        'format': 'png',
    })
    with urllib.request.urlopen(thumb_url, timeout=60) as response:
        image_url = 'data:image/png;base64,' + base64.b64encode(response.read()).decode('ascii')

    mean_value = None
    if request['index'] != 'RGB':
        stats = selected.reduceRegion(
            reducer=ee.Reducer.mean(), geometry=region, scale=20,
            bestEffort=True, maxPixels=1_000_000_000,
        ).getInfo()
        mean_value = finite_number(stats.get(request['index']))

    context = context_evidence(region, request, scene_count, unit_metrics)

    return {
        'imageUrl': image_url,
        'index': request['index'],
        'sceneCount': scene_count,
        'mean': mean_value,
        'unitMetrics': unit_metrics,
        'generatedAt': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
        'projectId': PROJECT_ID,
        'dataSource': 'COPERNICUS/S2_SR_HARMONIZED',
        'scaleM': 20,
        'qualityNote': '已使用SCL剔除云、云影和雪像元；单元有效覆盖率过低时应延长时间窗口。',
        'context': context,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = 'ShuimaiGeeBridge/1.0'

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.send_header('cache-control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != '/health':
            self.send_json({'error': 'not found'}, 404)
            return
        try:
            initialize()
            ee.Number(1).getInfo()
            self.send_json({'configured': True, 'projectId': PROJECT_ID, 'authMode': 'local_user'})
        except Exception as exc:  # noqa: BLE001
            self.send_json({'configured': False, 'error': str(exc)[:600]}, 503)

    def do_POST(self) -> None:  # noqa: N802
        if self.path != '/analyze':
            self.send_json({'error': 'not found'}, 404)
            return
        try:
            length = int(self.headers.get('content-length', '0'))
            if length < 1 or length > MAX_BODY_BYTES:
                raise ValueError('研究区请求过大或为空。')
            self.send_json(analyze(json.loads(self.rfile.read(length))))
        except ValueError as exc:
            self.send_json({'error': str(exc)}, 400)
        except Exception as exc:  # noqa: BLE001
            print(f'[GEE bridge] {type(exc).__name__}: {exc}', file=sys.stderr, flush=True)
            self.send_json({'error': f'GEE分析失败：{str(exc)[:700]}'}, 502)

    def log_message(self, message: str, *args: Any) -> None:
        print('[GEE bridge] ' + (message % args), flush=True)


def main() -> None:
    global PROJECT_ID
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', default=os.environ.get('GEE_CLOUD_PROJECT_ID') or project_from_dev_vars())
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    if not args.project:
        parser.error('请通过 --project、GEE_CLOUD_PROJECT_ID 或 .dev.vars 配置Earth Engine Cloud项目。')
    PROJECT_ID = args.project
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'GEE local bridge ready: http://{args.host}:{args.port} ({PROJECT_ID})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
