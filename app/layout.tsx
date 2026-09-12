import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '水脉智调｜湿地生态补水决策',
  description: '面向湿地研究区的水分风险诊断、补水情景比较与生态补水处方原型。',
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
