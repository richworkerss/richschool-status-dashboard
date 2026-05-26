/**
 * 로컬 개발용 — NAS 상태 API
 *
 * 운영(Cloudflare Pages): Workers /api/nas-status 가 D1 데이터를 반환합니다.
 * 이 파일은 NEXT_PUBLIC_CF_WORKERS_URL 미설정 시(로컬 개발)에만 사용됩니다.
 *
 * output: 'export' 빌드 시 pages/api/ 는 자동으로 제외됩니다.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getNasStorageInfo, isNasConfigured } from '@/lib/nas-storage';
import { maybeRecordSnapshot }               from '@/lib/storage-history';
import type { NasStorageResponse }           from '@/lib/types';

export default async function handler(
  _req: NextApiRequest,
  res:  NextApiResponse<NasStorageResponse>,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isNasConfigured()) {
    return res.json({
      ok: false, error: 'NAS 계정 정보가 설정되어 있지 않습니다.', configured: false,
    });
  }

  try {
    const data = await getNasStorageInfo();

    // 로컬 개발 편의 — 페이지 방문 시 로컬 JSON에 스로틀 기록 (1시간 간격)
    if (data.totalBytes != null && data.totalBytes > 0 && data.usedBytes != null) {
      maybeRecordSnapshot(data.totalBytes, data.usedBytes);
    }

    res.json({ ok: true, data });
  } catch (err) {
    res.json({
      ok: false, error: (err as Error).message ?? '알 수 없는 오류가 발생했습니다.', configured: true,
    });
  }
}
