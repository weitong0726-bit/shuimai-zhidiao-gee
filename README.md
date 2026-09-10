# 水脉智调

面向湿地生态监测的研究区 Google Earth Engine 遥感分析网站。用户上传自己的研究区边界后，可以直接计算并查看 Sentinel-2 真彩色影像、NDVI、NDMI 和 MNDWI，无需登录 Google Earth Engine。

## 在线演示

https://shuimai-zhidiao.weitong0726.chatgpt.site

## 主要功能

- 支持上传 Shapefile ZIP（`.shp`、`.shx`、`.dbf`、`.prj`）和 GeoJSON
- 在浏览器中预览研究区边界、中心位置和面积
- 按日期范围检索 Sentinel-2 SR Harmonized 影像
- 生成 RGB、NDVI、NDMI、MNDWI 遥感结果
- 返回有效影像数量和指数区域均值
- 通过服务端服务账号访问 GEE，访客无需 Google 账号
- 包含边界大小、要素数量、日期跨度和请求频率限制

## 本地运行

需要 Node.js 22.13 或更高版本，以及 pnpm。

```bash
pnpm install
pnpm dev
```

网站服务端需要配置环境变量 `GEE_SERVICE_ACCOUNT_JSON`，其值为已获 Earth Engine 项目权限的 Google Cloud 服务账号 JSON。不要把真实 JSON 密钥提交到 GitHub。

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

服务账号私钥只应保存在本地环境或托管平台的加密环境变量中。仓库已忽略 `.env*`、构建输出和证书文件。
