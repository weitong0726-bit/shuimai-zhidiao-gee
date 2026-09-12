# 水脉智调

面向湿地生态补水决策的 Google Earth Engine 遥感分析与处方原型。系统以管理单元为对象，将“边界界定—遥感诊断—背景证据—输水约束—处方分配—补水后复测”串成可导出的证据闭环。

## 在线演示

https://shuimai-zhidiao.weitong0726.chatgpt.site

## 主要功能

- 一键载入演示研究区，或上传 Shapefile ZIP / GeoJSON
- 以 Sentinel-2 SR Harmonized 计算 RGB、NDVI、NDMI、MNDWI
- 使用 SCL 剔除云、云影和雪，并返回单元有效覆盖率
- 输出单元面积、水面面积和三个指数的统计值
- 读取 ERA5-Land 降水、潜在蒸发、径流和 0—7 cm 土壤水分
- 读取 JRC Global Surface Water 历史水面出现频率与季节性
- 生成近 5 年同季节窗口时间序列、NDMI 异常值和证据信心等级
- 基于 NDMI 亏缺、MNDWI 亏缺和 NDVI 弱势构建可解释压力分
- 比较风险优先、缺水比例、面积比例和不补水基线四种策略
- 设置水源可供量、单元线路状态、到达效率和输水上限
- 在水源和线路双重约束下，形成单元建议水量、有效水深和方案后风险
- 对输水效率做灵敏度分析，并显示未满足水量
- 导出处方 CSV，以及含边界、观测、气候背景、输水网络、决策、基线和假设的 JSON 证据包
- 保存补水前基线，并在补水后 7—14 天进行同指标复测对比
- 支持上传 Shapefile ZIP（`.shp`、`.shx`、`.dbf`、`.prj`）和 GeoJSON
- 包含边界大小、要素数量、日期跨度和请求频率限制

## 数据边界

`public/wetland-data/` 中的演示边界和情景数据只用于展示交互。H1/H2 研究窗口和 A/B/C 情景单元不能直接视为已确认湿地或实际补水管理单元。洪水压力仅是根据径流、近期水面和历史水面频率得到的筛查分，不是水动力洪水风险模型。正式调度前仍应补充真实水源、闸门/渠道拓扑、输水效率、水位、土壤水分和现场样点数据。

## 方法与数据源

- [Sentinel-2 SR Harmonized](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_S2_SR_HARMONIZED)：20 m 单元统计，SCL 质量控制，输出 NDVI、NDMI、MNDWI 与识别水面。
- [ERA5-Land Daily Aggregated](https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_LAND_DAILY_AGGR)：研究区日尺度聚合，用于解释当期降水—潜在蒸发平衡、径流与表层土壤水分。
- [JRC Global Surface Water v1.4](https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_GlobalSurfaceWater)：用于提供长时间水面出现频率和季节性背景。
- 处方风险分是透明的情景指标，水深响应尺度、上限和输水效率都必须用实测数据校准。

## 本地运行

需要 Node.js 22.13 或更高版本、pnpm 和 Python 3.10+。

```bash
pnpm install
python3 -m venv .venv-gee
.venv-gee/bin/python -m pip install -r tools/requirements-gee.txt
cp .dev.vars.example .dev.vars
```

先确保本机已有 Earth Engine 用户授权（`~/.config/earthengine/credentials`），并在 `.dev.vars` 中填写已注册 Earth Engine 的 Cloud Project ID。随后一次启动网站和本地桥接：

```bash
pnpm dev:full
```

默认访问 `http://localhost:3000/`。也可以分别运行 `pnpm dev:gee` 和 `pnpm dev`。

网站支持两种 Earth Engine 接入方式：

- 本地研究和演示：本机 Python 桥接直接读取 Earth Engine CLI 保存的授权，浏览器和源码均不保存刷新令牌。
- 正式部署：配置 `GEE_SERVICE_ACCOUNT_JSON`，其值为已获 Earth Engine 项目权限的 Google Cloud 服务账号 JSON。

服务端对同一边界、日期和指标的成功结果保留 15 分钟内存缓存（最多 4 项），并在响应头中返回 `x-request-id` 和 `x-analysis-cache`，方便诊断和避免重复调用 GEE。请求频率默认限制为每个来源每小时 12 次。

本地可参考 `.dev.vars.example`。真实凭据只能放入已忽略的 `.dev.vars`、Earth Engine 用户配置目录或部署平台的密钥管理中，不要提交到 GitHub。

## 构建与检查

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

## 技术栈

- React 19 + TypeScript
- Vinext / Vite
- Tailwind CSS
- shpjs
- Google Earth Engine JavaScript API 与 REST `computePixels`

## 安全说明

本地桥接仅监听 `127.0.0.1`，应用端也拒绝代理到非本机桥接地址。服务账号私钥只应保存在本地环境或托管平台的加密环境变量中。仓库已忽略 `.env*`、`.dev.vars*`、Python 虚拟环境、构建输出和证书文件。
