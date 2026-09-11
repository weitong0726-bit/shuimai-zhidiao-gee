import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '水脉智调｜湿地遥感与缺水诊断',
  description: '导入研究区边界，通过Google Earth Engine读取逐单元遥感证据，结合ERA5气象与根区参数完成连续7天缺水诊断。',
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
