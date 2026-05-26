/**
 * 로컬 개발용 — 저장소 히스토리 API
 *
 * 운영(Cloudflare Pages): Workers /api/storage-history 가 D1 데이터를 반환합니다.
 * 이 파일은 NEXT_PUBLIC_CF_WORKERS_URL 미설정 시(로컬 개발)에만 사용됩니다.
 *
 * output: 'export' 빌드 시 pages/api/ 는 자동으로 제외됩니다.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getAllSnapshots, getRecentSnapshots } from '@/lib/storage-history';
import type { StorageHistoryResponse }         from '@/lib/types';

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse<StorageHistoryResponse>,
): void {
  try {
    const daysParam = req.query.days;
    const days      = Array.isArray(daysParam) ? daysParam[0] : daysParam;

    const snapshots = days
      ? getRecentSnapshots(Math.min(Math.max(parseInt(days, 10) || 30, 1), 365))
      : getAllSnapshots();

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json({ ok: true, snapshots });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message ?? '히스토리 조회 중 오류가 발생했습니다.' });
  }
}
