/* 水脉智调 | Google Earth Engine Code Editor
 * 公开数据筛查脚本：候选湿地—水分压力—潜在可达性—历史回测。
 * 所有“水量”都是等效水深情景，不是调度指令；导出任务需在Tasks手动运行。
 */
var START = '2025-06-01';
var END = '2025-07-01';
var PERIOD_DAYS = 7;
var SCALE = 20;
var CRS = 'EPSG:32649';

// BEGIN_ANALYSIS_UNITS
var units = ee.FeatureCollection([
  ee.Feature(
    ee.Geometry.Polygon([
      [
        [113.5391, 34.9205],
        [113.5393, 34.9295],
        [113.5503, 34.9293],
        [113.55, 34.9203],
        [113.5391, 34.9205],
      ],
    ]),
    { id: 'U1', name: '示例分析单元' },
  ),
]);
// END_ANALYSIS_UNITS

var roi = units.geometry();
Map.centerObject(roi);
Map.setOptions('SATELLITE');
Map.addLayer(units, { color: 'f0c85f' }, '分析单元边界');

function prepare(image) {
  var scl = image.select('SCL');
  var clear = scl
    .neq(0)
    .and(scl.neq(1))
    .and(scl.neq(3))
    .and(scl.neq(8))
    .and(scl.neq(9))
    .and(scl.neq(10))
    .and(scl.neq(11));
  return image
    .select(['B2', 'B3', 'B4', 'B8', 'B11'])
    .multiply(0.0001)
    .updateMask(clear)
    .copyProperties(image, ['system:time_start', 'system:index']);
}

function indices(image) {
  return image
    .normalizedDifference(['B8', 'B4'])
    .rename('NDVI')
    .addBands(image.normalizedDifference(['B8', 'B11']).rename('NDMI'))
    .addBands(image.normalizedDifference(['B3', 'B11']).rename('MNDWI'));
}

var s2 = ee
  .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(roi)
  .filterDate(START, END)
  .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', 80))
  .map(prepare);
var composite = s2.median();
var metricImage = indices(composite);
print('Sentinel-2影像颗粒数（不是独立样本数）', s2.size());

var jrc = ee.Image('JRC/GSW1_4/GlobalSurfaceWater');
var dw = ee
  .ImageCollection('GOOGLE/DYNAMICWORLD/V1')
  .filterBounds(roi)
  .filterDate(START, END)
  .select(['water', 'flooded_vegetation'])
  .mean();
var candidate = jrc
  .select('occurrence')
  .gt(5)
  .or(dw.select('water').max(dw.select('flooded_vegetation')).gt(0.25))
  .rename('candidate_wetland');
var candidateMask = candidate.unmask(0);
var merit = ee.Image('MERIT/Hydro/v1_0_1');
var lowHand = ee.Image(1).subtract(merit.select('hnd').clamp(0, 10).divide(10));
var potentialAccess = lowHand
  .multiply(0.65)
  .add(
    jrc.select('occurrence').unmask(0).divide(100).clamp(0, 1).multiply(0.35),
  )
  .multiply(100)
  .rename('potential_access');

var valid = metricImage.mask().reduce(ee.Reducer.min()).rename('valid');
var water = metricImage
  .select('MNDWI')
  .gt(0)
  .and(metricImage.select('NDVI').lt(0.3))
  .rename('water');
var pixelArea = ee.Image.pixelArea();
var areaBands = pixelArea
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
var analysisImage = metricImage
  .updateMask(candidate)
  .addBands(potentialAccess.updateMask(candidate))
  .addBands(merit.select('hnd').rename('hand_m').updateMask(candidate))
  .addBands(areaBands);
var reducer = ee.Reducer.mean().combine({
  reducer2: ee.Reducer.sum(),
  sharedInputs: true,
});
var unitResults = analysisImage
  .reduceRegions({
    collection: units,
    reducer: reducer,
    scale: SCALE,
    crs: CRS,
    tileScale: 4,
  })
  .map(function (feature) {
    var area = ee.Number(feature.get('pixel_area_m2_sum'));
    var candidateArea = ee.Number(feature.get('candidate_wetland_area_m2_sum'));
    var validArea = ee.Number(feature.get('valid_area_m2_sum'));
    return feature.set({
      candidate_fraction: candidateArea.divide(area).min(1),
      valid_fraction: validArea.divide(candidateArea).min(1),
      interpretation: 'public_data_screening_not_engineering_dispatch',
      scale_m: SCALE,
      data_sources: 'Sentinel-2,JRC GSW,Dynamic World,MERIT Hydro',
    });
  });
print('分析单元筛查结果', unitResults);

Map.addLayer(
  composite.clip(roi),
  { bands: ['B4', 'B3', 'B2'], min: 0, max: 0.3 },
  'Sentinel-2真彩色',
);
Map.addLayer(
  candidate.selfMask().clip(roi),
  { palette: ['2d9c86'] },
  '湿地候选区：JRC + Dynamic World',
);
Map.addLayer(
  metricImage.select('NDMI').updateMask(candidate).clip(roi),
  { min: -0.3, max: 0.5, palette: ['9f5025', 'f0d9ad', 'a6d6be', '006d77'] },
  '候选区NDMI',
  false,
);
Map.addLayer(
  potentialAccess.updateMask(candidate).clip(roi),
  { min: 0, max: 100, palette: ['8c510a', 'f6e8c3', '01665e'] },
  '潜在可达性',
  false,
);

var startDate = ee.Date(START);
var startYear = ee.Number.parse(startDate.format('YYYY'));
var years = ee.List.sequence(startYear.subtract(4).max(2017), startYear);
var annualSeries = ee.FeatureCollection(
  years.map(function (year) {
    year = ee.Number(year);
    var begin = ee.Date.fromYMD(
      year,
      startDate.get('month'),
      startDate.get('day'),
    );
    var finish = begin.advance(
      ee.Date(END).difference(startDate, 'day'),
      'day',
    );
    var yearly = ee
      .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(roi)
      .filterDate(begin, finish)
      .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', 80))
      .map(prepare);
    var stats = indices(yearly.median()).updateMask(candidate).reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: roi,
      scale: SCALE,
      crs: CRS,
      bestEffort: true,
      maxPixels: 1e9,
      tileScale: 4,
    });
    return ee.Feature(null, stats).set({
      year: year,
      period_start: begin.format('YYYY-MM-dd'),
      period_end_exclusive: finish.format('YYYY-MM-dd'),
      scene_count: yearly.size(),
    });
  }),
);
print('近5年同物候期序列', annualSeries);
print(
  ui.Chart.feature
    .byFeature(annualSeries, 'year', ['NDVI', 'NDMI', 'MNDWI'])
    .setOptions({ title: '候选湿地区同物候期遥感序列' }),
);

Export.table.toDrive({
  collection: unitResults,
  description: 'shuimai_unit_screening',
  folder: 'shuimai_competition',
  fileNamePrefix: 'shuimai_unit_screening',
  fileFormat: 'CSV',
});
Export.table.toDrive({
  collection: annualSeries,
  description: 'shuimai_annual_backtest',
  folder: 'shuimai_competition',
  fileNamePrefix: 'shuimai_annual_backtest',
  fileFormat: 'CSV',
});
Export.image.toDrive({
  image: analysisImage.clip(roi),
  description: 'shuimai_screening_raster',
  folder: 'shuimai_competition',
  fileNamePrefix: 'shuimai_screening_raster',
  region: roi,
  scale: SCALE,
  crs: CRS,
  maxPixels: 1e13,
  fileFormat: 'GeoTIFF',
});
print(
  '请在Tasks中手动运行导出。输出用于优先调查和情景比较，不证明实际渠道可达或补水效果。',
);
