import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '水脉智调｜湿地生态补水智能决策系统',
  description: '面向黄河流域气候韧性的湿地生态补水智能决策系统。',
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
