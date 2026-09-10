import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '水脉智调｜研究区边界导入',
  description: '在浏览器中导入Shapefile ZIP或GeoJSON，预览研究区边界并生成对应的Google Earth Engine分析脚本。',
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
