# 水脉智调

面向湿地生态补水前期论证的 Google Earth Engine 筛查工具。系统把“分析单元—湿地候选区—水分压力—潜在可达性—水量情景—历史回测”串成可导出的证据链。它回答“哪里值得优先调查、不同水量假设下排序怎样变化”，不在缺少水源、渠道和实测资料时冒充工程调度系统。

## 主要功能

- 上传 Shapefile ZIP / GeoJSON，自动转为二维 WGS84 GeoJSON，最多支持 150 个面要素
- 内置用户提供的黄河滩区中下游 28 个涉及县域，作为本项目实跑案例
- 使用 Sentinel-2 SR Harmonized 与 SCL 质量控制计算 NDVI、NDMI、MNDWI
- 以 JRC Global Surface Water 和 Dynamic World 水体/淹水植被概率识别湿地候选区
- 以 MERIT Hydro HAND 和历史水面频率构建“潜在可达性”筛查分
- 读取 ERA5-Land 降水、潜在蒸发、径流和表层土壤水分
- 生成近 5 年同物候期序列、NDMI 异常值和证据信心等级
- 对候选湿地计算遥感水分压力，并比较 2、5、10 mm 三档等效水深情景
- 比较需求—可达性综合、水分压力、候选区面积和不补水基线四种透明策略
- 导出全部县域结果 CSV 和包含边界、数据证据、情景、排序及假设的 JSON 证据包
- 保存任一时期为历史回测基线；仅在指标一致时比较变化，并明确禁止直接作因果归因

## 黄河滩区案例的解释边界

`public/wetland-data/yellow_river_counties.geojson` 来源于用户提供的“黄河滩区中下游县区边界” Shapefile，共 28 个县级行政区。该文件表示滩区涉及县域，不是精确滩区淹没边界，也不是现成湿地管理单元；属性中仍含“吉利区”，说明行政区划现势性需要复核。因此：

- 整县面积不能表述为黄河滩区面积；
- 候选湿地面积是公开遥感规则识别的筛查面积，不是已核定湿地面积；
- 东平湖等县域内其他水体会进入候选区，后续应增加精确滩区边界或黄河廊道掩膜；
- 潜在可达性只反映低 HAND 地形位置和历史水面关系，不表示渠道真实连通；
- 2 / 5 / 10 mm 水量由候选区面积换算，仅用于比较，不是批准水量或实施处方。
- 情景分配设置单元等效水深不超过该情景平均水深 2 倍，避免小候选区获得不合理水深；该上限仍需实测标定。

## 方法与数据源

- [Sentinel-2 SR Harmonized](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED)：SCL 剔除云、云影和雪，输出 NDVI、NDMI、MNDWI；统计尺度随研究区范围在 20—500 m 间自适应。
- [Dynamic World V1](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1)：使用当期 `water` 和 `flooded_vegetation` 概率补充候选区。
- [JRC Global Surface Water v1.4](https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_GlobalSurfaceWater)：历史水面出现频率超过 5% 的像元进入候选区，并参与潜在可达性计算。
- [MERIT Hydro v1.0.1](https://developers.google.com/earth-engine/datasets/catalog/MERIT_Hydro_v1_0_1)：使用 HAND（`hnd`）构建低地形位置指标。
- [ERA5-Land Daily Aggregated](https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_LAND_DAILY_AGGR)：解释同期降水—潜在蒸发平衡、径流与表层土壤水分背景。

当前候选区规则为 `JRC occurrence > 5%` 或 `max(Dynamic World water, flooded_vegetation) > 0.25`。潜在可达性为 `65% × 低 HAND 分 + 35% × JRC 历史水面频率`。水分压力为 `55% × NDMI 亏缺 + 25% × MNDWI 亏缺 + 20% × NDVI 弱势`。这些阈值与权重均公开可查，但仍需在论文中做敏感性分析，并用样点或已有调查成果验证。

## 从筛查升级到工程应用还缺什么

至少需要精确滩区/湿地管理单元、真实水源及可供量、渠道与闸门拓扑、输水效率、实际补水起止时间和水量、同期黄河来水与降雨，以及一轮固定样点水位/土壤水分或植被调查。获得这些资料后才能校准响应模型、验证渠道可达性并讨论真实调度。

## 本地运行

需要 Node.js 22.13+ 和 Python 3.10+。

```bash
npm install
python3 -m venv .venv-gee
.venv-gee/bin/python -m pip install -r tools/requirements-gee.txt
cp .dev.vars.example .dev.vars
```

先确保本机已有 Earth Engine 用户授权（`~/.config/earthengine/credentials`），并在 `.dev.vars` 中填写已注册 Earth Engine 的 Cloud Project ID，然后运行：

```bash
npm run dev:full
```

默认访问 `http://localhost:3000/`。本地桥接只监听 `127.0.0.1`，浏览器和源码不保存刷新令牌。正式部署需配置具有 Earth Engine 项目权限的 `GEE_SERVICE_ACCOUNT_JSON`。真实凭据只能进入已忽略的 `.dev.vars`、Earth Engine 用户配置目录或部署平台密钥管理，不能提交到 GitHub。

## 构建与检查

```bash
npm run format
npm run lint
npx tsc --noEmit
npm run build
```

技术栈：React 19、TypeScript、Vinext / Vite、Tailwind CSS、shpjs、Google Earth Engine JavaScript API 与 REST `computePixels`。
