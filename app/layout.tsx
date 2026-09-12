import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '水脉智调｜湿地生态补水优先区筛查',
  description:
    '基于公开遥感与水文地形数据的湿地候选区识别、补水优先级筛查与情景推演。',
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
