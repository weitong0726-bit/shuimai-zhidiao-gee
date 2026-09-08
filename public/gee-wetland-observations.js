/* 水脉智调 | Google Earth Engine Code Editor
 * 只读取公开影像、计算统计并准备导出任务；不会自动提交Drive导出。
 * 本脚本已做本地语法检查，尚未在用户GEE账户执行验证。
 * 第一次运行：脚本已装入边界筛选阶段得到的H1/H2核查窗口；
 * 请在卫星底图上逐一检查位置、地类和边界，再决定是否确认。
 * 注意：候选区未验证为湿草地，也未验证其可独立补水。
 */
var BOUNDARIES_CONFIRMED = false;
var START = '2025-06-01';
var END = '2025-07-01'; // 排他结束日期；与本地ERA5六月数据对齐
var PERIOD_DAYS = 7;
var SCALE = 20; // B11原生20m，NDMI/MNDWI不宣称10m独立信息
var CRS = 'EPSG:32649'; // 郑州附近UTM 49N

// H1/H2坐标来自“惠济两个核查窗口.geojson”，面积均约1 km²。
// 有正式资产时可替换整个定义：ee.FeatureCollection('projects/.../assets/...')。
// 每个feature必须有唯一id，且多边形不得重叠。
var units = ee.FeatureCollection([
  ee.Feature(ee.Geometry.Polygon([[[113.53905875702601,34.92050877466985],[113.53933645648615,34.92951744702241],[113.55027493508308,34.92928819932494],[113.54999604255539,34.92027960329506],[113.53905875702601,34.92050877466985]]]), {id:'H1'}),
  ee.Feature(ee.Geometry.Polygon([[[113.72256892249702,34.889409605139036],[113.7228663344928,34.898416993759575],[113.7337990696116,34.89817141492646],[113.73350046707914,34.88916410808702],[113.72256892249702,34.889409605139036]]]), {id:'H2'})
]);
var roi = units.geometry().bounds();
Map.centerObject(roi,13);
Map.setOptions('SATELLITE');
Map.addLayer(units,{color:'ffff00'},'待确认的研究单元边界');
print('边界已人工确认？',BOUNDARIES_CONFIRMED);
print('必须先核查：湿草地类型、边界、面积、是否独立供水；本脚本不能证明这些条件。');

function prepare(image) {
  var scl = image.select('SCL');
  var clear = scl.neq(0).and(scl.neq(1)).and(scl.neq(3))
    .and(scl.neq(8)).and(scl.neq(9)).and(scl.neq(10)).and(scl.neq(11));
  var bands = image.select(['B2','B3','B4','B8','B11']).multiply(0.0001).updateMask(clear);
  var ndvi = bands.normalizedDifference(['B8','B4']).rename('ndvi');
  var ndmi = bands.normalizedDifference(['B8','B11']).rename('ndmi');
  var mndwi = bands.normalizedDifference(['B3','B11']).rename('mndwi');
  return bands.addBands([ndvi,ndmi,mndwi]).copyProperties(image,['system:time_start','system:index']);
}
var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(roi).filterDate(START,END)
  .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE',80)).map(prepare);
print('候选Sentinel-2影像颗粒数（不是独立样本数）',s2.size());
// 保证空窗口也有波段结构；空窗口输出valid_fraction=0和空指数。
var bandNames=['B2','B3','B4','B8','B11','ndvi','ndmi','mndwi'];
var empty=ee.Image.constant([0,0,0,0,0,0,0,0]).rename(bandNames).updateMask(ee.Image.constant(0));
function composite(collection) {
  return ee.Image(ee.Algorithms.If(collection.size().gt(0),collection.median(),empty));
}
var overview=composite(s2);
Map.addLayer(overview.clip(roi),{bands:['B4','B3','B2'],min:0,max:0.3},'月合成真彩色');
Map.addLayer(overview.select('ndmi').clip(roi),{min:-0.3,max:0.5,palette:['9f5025','f0d9ad','a6d6be','006d77']},'NDMI 植被水分相关指数',false);
Map.addLayer(overview.select('ndvi').clip(roi),{min:0,max:0.8,palette:['e7d5bd','bdd6a4','246544']},'NDVI',false);

// Dynamic World只帮助核查覆盖类型。分类概率与标签均不替代实地植被调查。
var dw = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').filterBounds(roi).filterDate(START,END);
var emptyLabel=ee.Image.constant(0).rename('label').updateMask(ee.Image.constant(0));
var dwLabel=ee.Image(ee.Algorithms.If(dw.size().gt(0),dw.select('label').mode(),emptyLabel));
Map.addLayer(dwLabel.clip(roi),{min:0,max:8,palette:['419bdf','397d49','88b053','7a87c6','e49635','dfc35a','c4281b','a59b8f','b39fe1']},'Dynamic World覆盖类型核查',false);
print('DW类别：0水体/1树木/2草地/3淹水植被/4作物/5灌丛/6建设/7裸地/8冰雪');

var startDate=ee.Date(START), endDate=ee.Date(END);
var count=endDate.difference(startDate,'day').divide(PERIOD_DAYS).ceil();
var periods=ee.List.sequence(0,count.subtract(1));
var tables=periods.map(function(k){
  var begin=startDate.advance(ee.Number(k).multiply(PERIOD_DAYS),'day');
  var finish=ee.Date(begin.advance(PERIOD_DAYS,'day').millis().min(endDate.millis()));
  var collection=s2.filterDate(begin,finish);
  var image=composite(collection);
  var valid=image.select(['ndvi','ndmi','mndwi']).mask().reduce(ee.Reducer.min());
  var water=image.select('mndwi').gt(0).and(image.select('ndvi').lt(0.3));
  // 水体阈值是待检验规则；同时输出有效面积，不把云区当作非水体。
  return units.map(function(feature){
    var geom=feature.geometry();
    var total=geom.area(1);
    var indexStats=image.select(['ndvi','ndmi','mndwi']).updateMask(valid).reduceRegion({
      reducer:ee.Reducer.mean(),geometry:geom,scale:SCALE,crs:CRS,maxPixels:1e7,tileScale:2
    });
    var areas=ee.Image.pixelArea().multiply(valid.unmask(0)).rename('valid_area_m2')
      .addBands(ee.Image.pixelArea().multiply(water.updateMask(valid).unmask(0)).rename('water_area_valid_m2'))
      .reduceRegion({reducer:ee.Reducer.sum(),geometry:geom,scale:SCALE,crs:CRS,maxPixels:1e7,tileScale:2});
    var validArea=ee.Number(areas.get('valid_area_m2',0));
    return ee.Feature(geom,indexStats).set(areas).set({
      id:feature.get('id'),period_start:begin.format('YYYY-MM-dd'),period_end_exclusive:finish.format('YYYY-MM-dd'),
      area_m2:total,valid_fraction:validArea.divide(total).min(1),scene_granules:collection.size(),
      scene_ids:collection.aggregate_array('system:index'),
      boundary_confirmed:BOUNDARIES_CONFIRMED,data_source:'COPERNICUS/S2_SR_HARMONIZED',scale_m:SCALE,
      interpretation:'satellite_observation_not_soil_moisture_or_ecological_damage'
    });
  });
});
var observations=ee.FeatureCollection(tables).flatten();
print('遥感统计含数据质量字段',observations);
print('NDMI时序：有效覆盖率至少70%；缺测保留为空，不插入0',
  ui.Chart.feature.groups(observations.filter(ee.Filter.gte('valid_fraction',0.7)),
    'period_start','ndmi','id').setOptions({title:'NDMI有效观测时序',hAxis:{title:'窗口起日'},vAxis:{title:'NDMI'}}));

Export.table.toDrive({collection:observations,description:'shuimai_observations',
  folder:'shuimai_competition',fileNamePrefix:'shuimai_observations',fileFormat:'GeoJSON'});
Export.image.toDrive({image:overview.select(['ndvi','ndmi','mndwi']).clip(roi),
  description:'shuimai_indices',folder:'shuimai_competition',fileNamePrefix:'shuimai_indices',
  region:roi,scale:SCALE,crs:CRS,maxPixels:1e8,fileFormat:'GeoTIFF'});
print('去Tasks运行导出；GeoJSON用于本地接入，GeoTIFF用于图件。未确认边界时本地程序拒绝作为正式区域导入。');
