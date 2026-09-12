# 水脉智调

面向湿地生态补水决策的 Google Earth Engine 遥感分析与处方原型。系统以管理单元为对象，将“边界界定—遥感诊断—有限水量分配—补水后复测”串成可导出的证据闭环。

## 在线演示

https://shuimai-zhidiao.weitong0726.chatgpt.site

## 主要功能

- 一键载入演示研究区，或上传 Shapefile ZIP / GeoJSON
- 以 Sentinel-2 SR Harmonized 计算 RGB、NDVI、NDMI、MNDWI
- 使用 SCL 剔除云、云影和雪，并返回单元有效覆盖率
- 输出单元面积、水面面积和三个指数的统计值
- 基于 NDMI 亏缺、MNDWI 亏缺和 NDVI 弱势构建可解释压力分
- 比较风险优先、缺水比例、面积比例和不补水基线四种策略
- 在给定生态水量下形成单元建议水量、有效水深和方案后风险
- 导出处方 CSV，以及含边界、观测、决策、基线和假设的 JSON 证据包
- 保存补水前基线，并在补水后 7—14 天进行同指标复测对比
- 支持上传 Shapefile ZIP（`.shp`、`.shx`、`.dbf`、`.prj`）和 GeoJSON
- 包含边界大小、要素数量、日期跨度和请求频率限制

## 数据边界

`public/wetland-data/` 中的演示数据用于展示模型交互，采用公开历史气象和情景地块参数，尚未完成现场验证。H1/H2 研究窗口和 A/B/C 单元不能直接视为已确认湿地或实际补水管理单元。正式应用前应补充真实水源、输水效率、土壤水分和现场样点数据。

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
