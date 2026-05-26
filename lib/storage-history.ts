/**
 * NAS 저장소 사용량 히스토리 — 파일 기반 스냅샷 관리
 *
 * 저장 파일: <프로젝트 루트>/data/storage-history.json
 * 형식: StorageSnapshot[] (JSON 배열, 오래된 것부터 정렬)
 * 기록 주기: 최소 1시간 간격으로 자동 조절 (API 호출 횟수와 무관)
 *
 * 이 파일은 서버 사이드 전용입니다. 클라이언트 컴포넌트에서
 * 타입만 필요하면 lib/types.ts의 StorageSnapshot 을 사용하세요.
 */
import fs from 'fs';
import path from 'path';
import type { StorageSnapshot } from './types';

export type { StorageSnapshot };

const DATA_DIR  = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'storage-history.json');

/** 스냅샷 두 개 사이의 최소 간격 (1시간) */
const MIN_INTERVAL_MS = 60 * 60 * 1000;

// ─── 파일 입출력 ───────────────────────────────────────────────────────────

function ensureFile(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
  }
}

function readAll(): StorageSnapshot[] {
  ensureFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StorageSnapshot[]) : [];
  } catch {
    return [];
  }
}

function writeAll(snapshots: StorageSnapshot[]): void {
  ensureFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(snapshots, null, 2), 'utf-8');
}

// ─── 공개 API ──────────────────────────────────────────────────────────────

/**
 * 스로틀 기록: 마지막 기록으로부터 1시간 이상 지났을 때만 새 스냅샷을 저장합니다.
 * totalBytes / usedBytes 중 하나라도 0 이하면 저장하지 않습니다.
 */
export function maybeRecordSnapshot(totalBytes: number, usedBytes: number): void {
  if (totalBytes <= 0 || usedBytes < 0) return;

  try {
    const all = readAll();
    const last = all[all.length - 1];

    if (last) {
      const elapsed = Date.now() - new Date(last.recordedAt).getTime();
      if (elapsed < MIN_INTERVAL_MS) return;
    }

    all.push({ recordedAt: new Date().toISOString(), totalBytes, usedBytes });
    writeAll(all);
  } catch {
    // 기록 실패는 조용히 무시합니다 (메인 API에 영향 없음).
  }
}

/**
 * 최근 N일 간의 스냅샷을 오래된 순서로 반환합니다.
 */
export function getRecentSnapshots(days: number): StorageSnapshot[] {
  const all = readAll();
  const cutoff = Date.now() - days * 86_400_000;
  return all.filter(s => new Date(s.recordedAt).getTime() >= cutoff);
}

/**
 * 스로틀 없이 즉시 스냅샷을 기록합니다.
 * cron 스크립트 전용 — 호출 간격은 cron 스케줄로 제어합니다.
 */
export function recordSnapshot(totalBytes: number, usedBytes: number): void {
  if (totalBytes <= 0 || usedBytes < 0) return;
  const all = readAll();
  all.push({ recordedAt: new Date().toISOString(), totalBytes, usedBytes });
  writeAll(all);
}

/**
 * 전체 스냅샷을 오래된 순서로 반환합니다.
 */
export function getAllSnapshots(): StorageSnapshot[] {
  return readAll();
}
