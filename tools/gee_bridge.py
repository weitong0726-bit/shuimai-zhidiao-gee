#!/usr/bin/env python3
"""Local-only Earth Engine bridge for researchers using saved user OAuth credentials.

The browser never receives refresh tokens. Production deployments should use the
service-account path in app/api/gee/route.ts instead of exposing this bridge.
"""

from __future__ import annotations

import argparse
import base64
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
