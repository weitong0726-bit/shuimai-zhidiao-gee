import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '水脉智调｜湿地生态补水决策原型',
  description: '面向黄河郑州段候选区域的公开数据驱动型湿地生态补水决策研究原型。',
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
