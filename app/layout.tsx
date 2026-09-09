import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '河韧智镜｜黄河滩区生态韧性数智平台',
  description: '面向黄河滩区中下游的遥感数字孪生、生态韧性诊断与智能治理原型。',
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
