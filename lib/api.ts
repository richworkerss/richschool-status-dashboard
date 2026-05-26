/**
 * API 기본 URL 유틸리티
 *
 * - 운영 (Cloudflare Pages): NEXT_PUBLIC_CF_WORKERS_URL → Workers URL 반환
 * - 로컬 개발 (env 없음)   : 빈 문자열 → 동일 오리진 Next.js API 경로 사용
 *
 * 사용 예:
 *   fetch(getApiBase() + '/api/services')
 *   // 운영: https://richschool-dashboard-api.xxx.workers.dev/api/services
 *   // 로컬: /api/services
 */
export function getApiBase(): string {
  return (process.env.NEXT_PUBLIC_CF_WORKERS_URL ?? '').replace(/\/$/, '');
}
