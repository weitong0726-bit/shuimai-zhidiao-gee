import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '水脉智调｜湿地生态补水智能决策系统',
  description: '支持自定义Shapefile或GeoJSON研究区的湿地遥感诊断与生态补水智能决策系统。',
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
