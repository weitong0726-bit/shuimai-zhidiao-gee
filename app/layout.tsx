import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '水脉智调｜研究区GEE遥感分析',
  description: '导入Shapefile ZIP或GeoJSON，连接Google Earth Engine并读取研究区的Sentinel-2、NDVI、NDMI与MNDWI结果。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
