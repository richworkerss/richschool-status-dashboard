import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Richschool 시스템 상태 대시보드',
  description: '리치스쿨 사내 주요 시스템의 현재 상태를 한 눈에 확인합니다.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
