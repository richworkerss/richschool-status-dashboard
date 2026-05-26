/**
 * 로컬 개발용 — 서비스 헬스체크 API
 *
 * 운영(Cloudflare Pages): NEXT_PUBLIC_CF_WORKERS_URL 이 설정되면
 *   프론트엔드가 Workers /api/services 를 직접 호출합니다.
 *   이 파일은 NEXT_PUBLIC_CF_WORKERS_URL 미설정 시(로컬 개발)에만 사용됩니다.
 *
 * output: 'export' 빌드 시 pages/api/ 는 자동으로 제외됩니다.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { services }         from '@/lib/services';
import { checkAllServices } from '@/lib/health-check';
import type { HealthResponse } from '@/lib/types';

export default async function handler(
  _req: NextApiRequest,
  res:  NextApiResponse<HealthResponse>,
): Promise<void> {
  const statuses = await checkAllServices(services);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.json({ checkedAt: new Date().toISOString(), services: statuses });
}
