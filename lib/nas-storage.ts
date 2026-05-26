/**
 * Synology DSM API 연동 — NAS 저장소 정보 조회
 *
 * 필요한 환경변수 (.env.local):
 *   NAS_HOST      NAS IP 또는 호스트명 (기본값: 192.168.1.136)
 *   NAS_PORT      DSM HTTPS 포트       (기본값: 5001)
 *   NAS_USER      DSM 계정 이름
 *   NAS_PASSWORD  DSM 계정 비밀번호
 *
 * 사용하는 API:
 *   1. SYNO.Storage.CGI.Storage   – 볼륨·디스크 목록 (메타 + 일부 용량)
 *   2. SYNO.Core.Storage.Volume   – 볼륨 용량 (DSM 7 추천 경로)
 *   3. SYNO.Storage.CGI.DiskMgmt  – 디스크 용량 보완
 *
 * 세 개를 동시에 호출하고 결과를 병합합니다.
 * 각 API가 실패하더라도 나머지로 최대한 정보를 채웁니다.
 */
import { Agent, fetch as undiciFetch } from 'undici';
import type { NasDisk, NasHealthLevel, NasStorageInfo, NasVolume } from './types';

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

const TIMEOUT_MS = 10_000;

/**
 * 환경변수를 모듈 로드 시점이 아닌 함수 호출 시점에 읽습니다.
 * 덕분에 cron 스크립트처럼 .env.local을 나중에 로드하는 환경에서도
 * 올바르게 동작합니다.
 */
function nasHost():     string             { return process.env.NAS_HOST     ?? '192.168.1.136'; }
function nasPort():     string             { return process.env.NAS_PORT     ?? '5001'; }
function nasUser():     string | undefined  { return process.env.NAS_USER; }
function nasPassword(): string | undefined  { return process.env.NAS_PASSWORD; }
function baseUrl():     string             { return `https://${nasHost()}:${nasPort()}`; }

export function isNasConfigured(): boolean {
  return !!(nasUser() && nasPassword());
}

// ─── 네트워크 헬퍼 ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function nasFetch(path: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await undiciFetch(`${baseUrl()}${path}`, {
      signal: controller.signal,
      dispatcher: insecureAgent,
      redirect: 'follow',
      headers: { 'User-Agent': 'RichschoolStatusDashboard/1.0' },
    });
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function login(): Promise<string> {
  const path =
    `/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login` +
    `&account=${encodeURIComponent(nasUser()!)}` +
    `&passwd=${encodeURIComponent(nasPassword()!)}` +
    `&session=NasDash&format=sid`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await nasFetch(path);
  if (!json?.success || !json.data?.sid) {
    const code = json?.error?.code;
    const hint =
      code === 400 ? '계정 또는 비밀번호가 올바르지 않습니다.' :
      code === 401 ? '계정이 비활성화되어 있습니다.' :
      code === 402 ? '계정이 잠겨 있습니다.' :
      `오류 코드 ${code ?? '알 수 없음'}`;
    throw new Error(`DSM 로그인 실패: ${hint}`);
  }
  return String(json.data.sid);
}

async function logout(sid: string): Promise<void> {
  try {
    await nasFetch(
      `/webapi/auth.cgi?api=SYNO.API.Auth&version=1&method=logout&session=NasDash&_sid=${sid}`,
    );
  } catch { /* 로그아웃 실패는 무시 */ }
}

// ─── 필드 탐색 ──────────────────────────────────────────────────────────────

/**
 * obj에서 paths를 순서대로 시도해 첫 번째로 유효한(> 0인) 정수를 반환합니다.
 * 점(.)으로 구분된 중첩 경로를 지원합니다 (예: "size.total").
 * 값을 찾지 못하면 null을 반환합니다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveField(obj: any, ...paths: string[]): number | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const path of paths) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let val: any = obj;
    for (const key of path.split('.')) {
      val = val?.[key];
    }
    if (val != null && val !== '') {
      const n = typeof val === 'number' ? val : parseInt(String(val), 10);
      if (!isNaN(n) && n > 0) return n;
    }
  }
  return null;
}

// ─── 상태 매핑 ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapVolumeStatus(v: any): NasHealthLevel {
  const s = String(v?.status ?? '').toLowerCase();
  if (s === 'normal')                                        return 'normal';
  if (s === 'degraded' || s === 'warning')                   return 'warning';
  if (s === 'crashed' || s === 'error' || s === 'read_only') return 'error';
  return 'unknown';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDiskHealth(d: any): NasHealthLevel {
  const combined = `${d?.status ?? ''} ${d?.smart_status ?? ''}`.toLowerCase();
  if (/warning|caution/.test(combined))     return 'warning';
  if (/error|failed|bad/.test(combined))    return 'error';
  if (/normal|good/.test(combined))         return 'normal';
  return 'unknown';
}

function volumeNameFromId(id: string, i: number): string {
  const m = id.match(/(\d+)$/);
  return `볼륨 ${m ? m[1] : i + 1}`;
}

function diskNameFromId(id: string, i: number): string {
  const m = id.match(/^([a-z]+)(\d+)$/i);
  if (!m) return `디스크 ${i + 1}`;
  return `디스크 ${m[2]} (${m[1].toUpperCase()})`;
}

// ─── 공개 함수 ─────────────────────────────────────────────────────────────

export async function getNasStorageInfo(): Promise<NasStorageInfo> {
  if (!nasUser() || !nasPassword()) {
    throw new Error(
      'NAS 계정 정보가 설정되어 있지 않습니다. .env.local에 NAS_USER와 NAS_PASSWORD를 입력해 주세요.',
    );
  }

  const sid = await login();
  try {
    // ── 네 API를 동시에 호출 ───────────────────────────────────────────────
    const [storageRaw, coreVolRaw, diskMgmtRaw, systemInfoRaw] = await Promise.all([
      nasFetch(
        `/webapi/entry.cgi?api=SYNO.Storage.CGI.Storage&version=1&method=load_info&_sid=${sid}`,
      ).catch(() => null),
      nasFetch(
        `/webapi/entry.cgi?api=SYNO.Core.Storage.Volume&version=1&method=list&_sid=${sid}`,
      ).catch(() => null),
      nasFetch(
        `/webapi/entry.cgi?api=SYNO.Storage.CGI.DiskMgmt&version=1&method=load_info&_sid=${sid}`,
      ).catch(() => null),
      nasFetch(
        `/webapi/entry.cgi?api=SYNO.Core.System&version=1&method=info&_sid=${sid}`,
      ).catch(() => null),
    ]);

    // ── 서버 콘솔 디버그 로그 (NAS_DEBUG=true 일 때만 출력) ─────────────────
    if (process.env.NAS_DEBUG === 'true') {
      console.log('\n[NAS Storage] ① SYNO.Storage.CGI.Storage (load_info):\n',  JSON.stringify(storageRaw,    null, 2));
      console.log('\n[NAS Storage] ② SYNO.Core.Storage.Volume (list):\n',       JSON.stringify(coreVolRaw,    null, 2));
      console.log('\n[NAS Storage] ③ SYNO.Storage.CGI.DiskMgmt (load_info):\n', JSON.stringify(diskMgmtRaw,   null, 2));
      console.log('\n[NAS Storage] ④ SYNO.Core.System (info):\n',               JSON.stringify(systemInfoRaw, null, 2));
    }

    if (!storageRaw?.success) {
      throw new Error(
        `스토리지 정보 조회 실패 (오류 코드: ${storageRaw?.error?.code ?? '알 수 없음'})`,
      );
    }

    const primary = storageRaw.data ?? {};

    // ── 보조 API 데이터를 ID 기준 Map으로 인덱싱 ───────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coreVolMap = new Map<string, any>();
    const coreVols: unknown[] =
      coreVolRaw?.data?.volumes ??
      coreVolRaw?.data?.list ??
      (Array.isArray(coreVolRaw?.data) ? coreVolRaw.data : []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const v of coreVols as any[]) {
      if (v?.id) coreVolMap.set(String(v.id), v);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diskMgmtMap = new Map<string, any>();
    const mgmtDisks: unknown[] =
      diskMgmtRaw?.data?.disks ??
      diskMgmtRaw?.data?.list ??
      (Array.isArray(diskMgmtRaw?.data) ? diskMgmtRaw.data : []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const d of mgmtDisks as any[]) {
      if (d?.id) diskMgmtMap.set(String(d.id), d);
    }

    // ── 볼륨 파싱 ──────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const volumes: NasVolume[] = ((primary.volumes ?? []) as any[]).map((v, i) => {
      const id    = String(v.id ?? `volume${i + 1}`);
      const coreV = coreVolMap.get(id);

      // 용량: SYNO.Core.Storage.Volume → SYNO.Storage.CGI.Storage 순으로 시도
      const totalBytes =
        resolveField(coreV, 'size_total', 'total_size', 'vol_size_total', 'size.total') ??
        resolveField(v,     'total_size', 'vol_size_total', 'size_total', 'size.total',
                            'volume_size', 'total');

      const usedBytes =
        resolveField(coreV, 'size_used', 'used_size', 'vol_size_used', 'size.used') ??
        resolveField(v,     'used_size', 'vol_size_used', 'size_used', 'size.used',
                            'volume_used', 'used');

      // RAID 유형: SYNO.Storage.CGI.Storage가 빈 문자열이면 Core에서 시도
      const raidType =
        String(v.raid_type ?? '').trim() ||
        String(coreV?.raid_type ?? coreV?.device_type ?? '').trim();

      return {
        id,
        name:       String(v.name ?? coreV?.name ?? volumeNameFromId(id, i)),
        status:     mapVolumeStatus(v),
        raidType,
        filesystem: String(v.fs_type ?? coreV?.fs_type ?? '').trim(),
        totalBytes,
        usedBytes,
      };
    });

    // ── 디스크 파싱 ────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const disks: NasDisk[] = ((primary.disks ?? []) as any[]).map((d, i) => {
      const id    = String(d.id ?? `disk${i + 1}`);
      const mgmtD = diskMgmtMap.get(id);

      // 디스크 용량: 다양한 필드명 시도
      const capacityBytes =
        resolveField(d,     'size', 'size_total', 'disk_size', 'capacity', 'total') ??
        resolveField(mgmtD, 'size', 'size_total', 'disk_size', 'capacity', 'total');

      return {
        id,
        name:          String(d.name ?? mgmtD?.name ?? diskNameFromId(id, i)),
        model:         String(d.model ?? mgmtD?.model ?? '').trim(),
        capacityBytes,
        health:        mapDiskHealth(d),
        temperatureC:  typeof d.temp === 'number' ? d.temp : null,
      };
    });

    // ── 전체 합산 ──────────────────────────────────────────────────────────
    const rawTotal = volumes.reduce((s, v) => s + (v.totalBytes ?? 0), 0);
    const rawUsed  = volumes.reduce((s, v) => s + (v.usedBytes  ?? 0), 0);

    // ── 업타임 추출 ────────────────────────────────────────────────────────
    // DSM 7: systemInfoRaw.data.up_time 은 "788:27:27" 형식의 문자열 (HH:MM:SS)
    const uptimeSeconds: number | null = (() => {
      const raw = systemInfoRaw?.data?.up_time;
      if (typeof raw === 'number') return raw; // 숫자로 오면 그대로 사용
      if (typeof raw !== 'string') return null;
      const parts = raw.split(':').map(Number);
      if (parts.length !== 3 || parts.some(isNaN)) return null;
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    })();

    return {
      fetchedAt:  new Date().toISOString(),
      totalBytes: rawTotal > 0 ? rawTotal : null,
      usedBytes:  rawUsed  > 0 ? rawUsed  : null,
      volumes,
      disks,
      uptimeSeconds,
    };
  } finally {
    await logout(sid);
  }
}
