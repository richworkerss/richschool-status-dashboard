/** @type {import('next').NextConfig} */

// NEXT_EXPORT=true 일 때 Cloudflare Pages 정적 배포용 설정을 적용합니다.
// - 로컬 개발 (npm run dev)  : 일반 Next.js 서버 모드, API 라우트 정상 동작
// - Cloudflare Pages 빌드   : NEXT_EXPORT=true npm run build → out/ 정적 파일 생성
//
// Cloudflare Pages 빌드 설정:
//   Build command:    npm run build
//   Output directory: out
//   Environment vars: NEXT_EXPORT=true
//                     NEXT_PUBLIC_CF_WORKERS_URL=https://...workers.dev
const isExport = process.env.NEXT_EXPORT === 'true';

const nextConfig = {
  reactStrictMode: true,

  ...(isExport && {
    output:        'export',
    trailingSlash: true,              // Cloudflare Pages 정적 라우팅 호환
    images:        { unoptimized: true }, // <Image> 최적화는 서버 필요 → 비활성화
  }),
};

module.exports = nextConfig;
