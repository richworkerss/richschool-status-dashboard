/**
 * NAS 저장소 사용량 기록 스크립트
 * ─────────────────────────────────────────────────────────────────────────────
 * NAS에서 현재 사용량을 조회하여 data/storage-history.json에 기록합니다.
 * 이 스크립트를 cron 또는 스케줄러에 등록해 주기적으로 실행하세요.
 *
 * 사용법 (프로젝트 루트에서 실행):
 *   npm run record-history           # 기본 실행 (1시간 스로틀 적용)
 *   npm run record-history:force     # 강제 기록 (스로틀 무시, 테스트용)
 *   npm run record-history:dry       # 실제 기록 없이 조회 결과만 출력
 *
 * 환경변수: 프로젝트 루트의 .env.local 또는 .env 에서 자동 로드합니다.
 * (NAS_HOST, NAS_PORT, NAS_USER, NAS_PASSWORD)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// ── .env 파일 로드 ─────────────────────────────────────────────────────────
//
// nas-storage.ts 의 환경변수는 "지연 읽기(lazy getter)" 방식으로 설계되어 있어,
// require() 시점이 아닌 함수 호출 시점에 process.env 를 읽습니다.
// 따라서 이 함수를 최상단에서 호출해 두면 이후의 모든 NAS 함수 호출에서
// 올바른 환경변수가 사용됩니다.
function loadEnvFiles(): void {
  const projectRoot = resolve(__dirname, '..');

  for (const file of ['.env.local', '.env']) {
    const filePath = resolve(projectRoot, file);
    if (!existsSync(filePath)) continue;

    const lines = readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const key = trimmed.slice(0, eqIdx).trim();
      let val   = trimmed.slice(eqIdx + 1).trim();

      // 따옴표 제거
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }

      // 이미 설정된 환경변수(시스템 레벨)는 덮어쓰지 않습니다.
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }
}

// 반드시 다른 lib 함수 호출 전에 실행
loadEnvFiles();

// ── lib 임포트 (env 로드 후 함수 호출 시점에서 env를 읽음) ─────────────────
import { getNasStorageInfo, isNasConfigured } from '../lib/nas-storage';
import { maybeRecordSnapshot, recordSnapshot } from '../lib/storage-history';

// ── CLI 플래그 ─────────────────────────────────────────────────────────────

const argv   = process.argv.slice(2);
const force  = argv.includes('--force');   // 1시간 스로틀 무시
const dryRun = argv.includes('--dry-run'); // 기록 없이 출력만

// ── 유틸리티 ───────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return `${i === 0 ? String(b) : (b / 1024 ** i).toFixed(1)} ${u[i]}`;
}

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function logErr(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ERROR: ${msg}\n`);
}

// ── 메인 ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = [force && '--force', dryRun && '--dry-run'].filter(Boolean).join(' ');
  log(`저장소 사용량 기록 시작${flags ? ` (${flags})` : ''}`);

  // 1. 계정 정보 확인
  if (!isNasConfigured()) {
    logErr('NAS 계정 정보가 없습니다. .env.local 에 NAS_USER 와 NAS_PASSWORD 를 입력해 주세요.');
    process.exit(1);
  }

  // 2. NAS 현재 사용량 조회
  let info: Awaited<ReturnType<typeof getNasStorageInfo>>;
  try {
    info = await getNasStorageInfo();
  } catch (err) {
    logErr(`NAS 연결 실패 — ${(err as Error).message}`);
    process.exit(1);
  }

  // 3. 용량 데이터 검증
  if (info.totalBytes == null || info.totalBytes <= 0 || info.usedBytes == null) {
    logErr('NAS 에서 용량 정보를 읽을 수 없습니다. API 응답을 서버 콘솔에서 확인해 주세요.');
    process.exit(1);
  }

  // 4. 결과 출력
  const usedPct  = ((info.usedBytes / info.totalBytes) * 100).toFixed(1);
  const freeBytes = info.totalBytes - info.usedBytes;
  log(`  전체   : ${fmtBytes(info.totalBytes)}`);
  log(`  사용 중 : ${fmtBytes(info.usedBytes)} (${usedPct}%)`);
  log(`  여유   : ${fmtBytes(freeBytes)}`);

  // 5. 기록
  if (dryRun) {
    log('dry-run 모드 — 실제 기록을 건너뜁니다.');
    return;
  }

  if (force) {
    recordSnapshot(info.totalBytes, info.usedBytes);
    log('기록 완료 (--force, 스로틀 무시)');
  } else {
    maybeRecordSnapshot(info.totalBytes, info.usedBytes);
    log('기록 완료 (1시간 이내 중복이면 자동으로 건너뜁니다)');
  }
}

main().catch(err => {
  logErr(`예기치 못한 오류: ${(err as Error).message ?? err}`);
  process.exit(1);
});
