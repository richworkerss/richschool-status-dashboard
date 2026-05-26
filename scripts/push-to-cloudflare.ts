/**
 * NAS 상태 + 서비스 헬스 → Cloudflare D1 푸시 스크립트
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 번의 실행에서 세 가지를 기록합니다:
 *   ① 저장소 스냅샷   → /api/ingest/storage
 *   ② NAS 전체 상태   → /api/ingest/nas-status  (볼륨·디스크·업타임)
 *   ③ 서비스 헬스체크 → /api/ingest/services
 *
 * 사용법 (프로젝트 루트에서 실행):
 *   npm run push-to-cf           # 기본 실행
 *   npm run push-to-cf:dry       # 조회만, Cloudflare 전송 없음 (테스트용)
 *
 * 환경변수 (.env.local 또는 .env):
 *   CF_WORKERS_URL    — Workers 배포 URL
 *   CF_INGEST_API_KEY — wrangler secret put CF_INGEST_API_KEY 로 등록한 키
 *   NAS_HOST, NAS_PORT, NAS_USER, NAS_PASSWORD
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { existsSync, readFileSync } from 'fs';
import { resolve }                  from 'path';

// ── .env 파일 로드 (NAS 함수 호출보다 먼저 실행) ─────────────────────────────
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
      let   val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}
loadEnvFiles();

// ── lib 임포트 ─────────────────────────────────────────────────────────────
import { getNasStorageInfo, isNasConfigured } from '../lib/nas-storage';
import { checkAllServices }                   from '../lib/health-check';
import { services }                           from '../lib/services';

// ── CLI 플래그 ─────────────────────────────────────────────────────────────
const argv   = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');

// ── 유틸리티 ───────────────────────────────────────────────────────────────
function fmtBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return `${i === 0 ? String(b) : (b / 1024 ** i).toFixed(1)} ${u[i]}`;
}
function log   (msg: string): void { process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`); }
function logErr(msg: string): void { process.stderr.write(`[${new Date().toISOString()}] ERROR: ${msg}\n`); }

// ── 인증 헤더 ──────────────────────────────────────────────────────────────
function makeHeaders(cfKey: string): HeadersInit {
  return { 'Content-Type': 'application/json', 'X-API-Key': cfKey };
}

// ── 개별 인제스트 함수 ─────────────────────────────────────────────────────

async function pushStorage(
  cfUrl: string, cfKey: string,
  recordedAt: string, totalBytes: number, usedBytes: number,
): Promise<boolean> {
  const res = await fetch(`${cfUrl}/api/ingest/storage`, {
    method: 'POST', headers: makeHeaders(cfKey),
    body: JSON.stringify({ recordedAt, totalBytes, usedBytes }),
  });
  if (!res.ok) {
    logErr(`저장소 스냅샷 전송 실패 (HTTP ${res.status}): ${await res.text().catch(() => '')}`);
    return false;
  }
  log('  ① 저장소 스냅샷 → D1 완료');
  return true;
}

async function pushNasStatus(
  cfUrl: string, cfKey: string,
  info: Awaited<ReturnType<typeof getNasStorageInfo>>,
): Promise<boolean> {
  const res = await fetch(`${cfUrl}/api/ingest/nas-status`, {
    method: 'POST', headers: makeHeaders(cfKey),
    body: JSON.stringify({
      recordedAt:    info.fetchedAt,
      totalBytes:    info.totalBytes,
      usedBytes:     info.usedBytes,
      uptimeSeconds: info.uptimeSeconds,
      volumes:       info.volumes,
      disks:         info.disks,
    }),
  });
  if (!res.ok) {
    logErr(`NAS 상태 전송 실패 (HTTP ${res.status}): ${await res.text().catch(() => '')}`);
    return false;
  }
  log('  ② NAS 전체 상태  → D1 완료');
  return true;
}

async function pushServices(
  cfUrl: string, cfKey: string,
  recordedAt: string,
): Promise<boolean> {
  // 서비스 헬스체크 실행 (내부망에서만 접근 가능한 서비스 포함)
  const statuses = await checkAllServices(services);

  const payload = statuses.map(s => ({
    id:         s.id,
    name:       s.name,
    category:   s.category,
    status:     s.status,
    responseMs: s.responseTimeMs,
    httpStatus: s.httpStatus,
    message:    s.message,
    openUrl:    s.openUrl,
  }));

  const res = await fetch(`${cfUrl}/api/ingest/services`, {
    method: 'POST', headers: makeHeaders(cfKey),
    body: JSON.stringify({ recordedAt, services: payload }),
  });
  if (!res.ok) {
    logErr(`서비스 상태 전송 실패 (HTTP ${res.status}): ${await res.text().catch(() => '')}`);
    return false;
  }

  const summary = statuses
    .filter(s => s.status !== 'placeholder')
    .map(s => `${s.name}(${s.status})`)
    .join(', ');
  log(`  ③ 서비스 헬스체크 → D1 완료  [${summary}]`);
  return true;
}

// ── 메인 ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // 1. 환경변수 확인
  const cfUrl = process.env.CF_WORKERS_URL?.replace(/\/$/, '');
  const cfKey = process.env.CF_INGEST_API_KEY;
  if (!cfUrl || !cfKey) {
    logErr(
      'CF_WORKERS_URL 또는 CF_INGEST_API_KEY가 설정되어 있지 않습니다.\n' +
      '  .env.local 에 두 값을 모두 입력해 주세요. (workers/README.md 참고)',
    );
    process.exit(1);
  }

  if (!isNasConfigured()) {
    logErr('NAS 계정 정보가 없습니다. .env.local 에 NAS_USER 와 NAS_PASSWORD 를 입력해 주세요.');
    process.exit(1);
  }

  log(`Cloudflare D1 푸시 시작${dryRun ? ' (dry-run)' : ''}`);
  log(`  대상: ${cfUrl}`);

  // 2. NAS 정보 조회
  let info: Awaited<ReturnType<typeof getNasStorageInfo>>;
  try {
    info = await getNasStorageInfo();
  } catch (err) {
    logErr(`NAS 연결 실패 — ${(err as Error).message}`);
    process.exit(1);
  }

  if (info.totalBytes == null || info.totalBytes <= 0 || info.usedBytes == null) {
    logErr('NAS 에서 용량 정보를 읽을 수 없습니다. API 응답을 서버 콘솔에서 확인해 주세요.');
    process.exit(1);
  }

  // 3. 조회 결과 출력
  const usedPct   = ((info.usedBytes / info.totalBytes) * 100).toFixed(1);
  const freeBytes = info.totalBytes - info.usedBytes;
  log(`  전체   : ${fmtBytes(info.totalBytes)}`);
  log(`  사용 중 : ${fmtBytes(info.usedBytes)} (${usedPct}%)`);
  log(`  여유   : ${fmtBytes(freeBytes)}`);
  log(`  볼륨   : ${info.volumes.length}개  디스크: ${info.disks.length}개`);

  if (dryRun) {
    log('dry-run 모드 — Cloudflare 전송을 건너뜁니다. 서비스 헬스체크도 생략합니다.');
    return;
  }

  // 4. 세 가지 동시 푸시 (독립 실행 — 하나가 실패해도 나머지는 계속)
  const recordedAt = info.fetchedAt;
  const [r1, r2, r3] = await Promise.all([
    pushStorage   (cfUrl, cfKey, recordedAt, info.totalBytes, info.usedBytes),
    pushNasStatus (cfUrl, cfKey, info),
    pushServices  (cfUrl, cfKey, recordedAt),
  ]);

  const failed = [r1, r2, r3].filter(ok => !ok).length;
  if (failed > 0) {
    logErr(`${failed}개 항목 전송 실패 — 위 ERROR 로그를 확인해 주세요.`);
    process.exit(1);
  }

  log('모든 데이터 전송 완료 ✓');
}

main().catch(err => {
  logErr(`예기치 못한 오류: ${(err as Error).message ?? err}`);
  process.exit(1);
});
