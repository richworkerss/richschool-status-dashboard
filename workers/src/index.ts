/**
 * Richschool Dashboard — Cloudflare Workers API
 *
 * 엔드포인트 (수집기 → D1):
 *   POST /api/ingest/storage    — 저장소 스냅샷 기록
 *   POST /api/ingest/nas-status — NAS 전체 상태 기록 (볼륨·디스크·업타임)
 *   POST /api/ingest/services   — 서비스 헬스 상태 기록
 *
 * 엔드포인트 (대시보드 → Workers):
 *   GET  /api/storage-history   — 저장소 스냅샷 조회
 *   GET  /api/nas-status        — 최신 NAS 상태 조회
 *   GET  /api/services          — 최신 서비스 상태 조회
 *   GET  /api/service-history   — 서비스 가동 이력 조회 (최근 30일)
 *
 * 인증: POST 엔드포인트는 X-API-Key 헤더 (= CF_INGEST_API_KEY secret) 필요
 *      GET  엔드포인트는 인증 없음 (Cloudflare Access로 팀 접근 제어)
 */

export interface Env {
  DB:                D1Database;
  CF_INGEST_API_KEY: string;
}

// ─── CORS + 공통 헬퍼 ──────────────────────────────────────────────────────

/**
 * Cloudflare Pages(및 로컬 개발 서버)에서 Workers API를 호출할 때
 * 브라우저의 Same-Origin Policy를 통과하기 위한 CORS 헤더입니다.
 *
 * Access-Control-Allow-Origin: *
 *   → 팀 내부 도구이므로 전체 오픈으로 설정합니다.
 *     필요 시 Pages 도메인(예: https://richschool-dashboard.pages.dev)으로 좁힐 수 있습니다.
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Max-Age':       '86400',
};

const NO_CACHE: Record<string, string> = {
  'Cache-Control': 'no-store, max-age=0',
};

/** JSON 응답 헬퍼 — CORS + charset=utf-8 을 모든 응답에 자동 포함합니다. */
function json(body: unknown, init?: ResponseInit): Response {
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
  };
  const extraHeaders = init?.headers as Record<string, string> | undefined;
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { ...baseHeaders, ...extraHeaders },
  });
}

function authFail(): Response {
  return json(
    { ok: false, error: '인증 실패: X-API-Key가 올바르지 않습니다.' },
    { status: 401 },
  );
}

function verifyKey(request: Request, env: Env): boolean {
  const key = request.headers.get('X-API-Key');
  return !!(key && key === env.CF_INGEST_API_KEY);
}

// ─── 라우터 ────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { method, url } = request;
    const { pathname }    = new URL(url);

    // OPTIONS preflight — 브라우저가 실제 요청 전에 보내는 사전 확인 요청
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // ── POST (수집기 → D1) ───────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/ingest/storage')    return handleIngestStorage(request, env);
    if (method === 'POST' && pathname === '/api/ingest/nas-status') return handleIngestNas(request, env);
    if (method === 'POST' && pathname === '/api/ingest/services')   return handleIngestServices(request, env);

    // ── GET (대시보드 → Workers) ─────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/storage-history')  return handleGetHistory(request, env);
    if (method === 'GET' && pathname === '/api/nas-status')       return handleGetNas(env);
    if (method === 'GET' && pathname === '/api/services')         return handleGetServices(env);
    if (method === 'GET' && pathname === '/api/service-history')  return handleGetServiceHistory(env);

    // ── 새로고침 트리거 ──────────────────────────────────────────────────
    if (method === 'POST' && pathname === '/api/request-refresh') return handleRequestRefresh(env);
    if (method === 'GET'  && pathname === '/api/poll')            return handlePoll(request, env);

    return json({ ok: false, error: 'Not Found' }, { status: 404 });
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/ingest/storage
// ═══════════════════════════════════════════════════════════════════════════

interface IngestStorageBody {
  recordedAt: string;
  totalBytes: number;
  usedBytes:  number;
}

async function handleIngestStorage(request: Request, env: Env): Promise<Response> {
  if (!verifyKey(request, env)) return authFail();

  let body: IngestStorageBody;
  try { body = await request.json() as IngestStorageBody; }
  catch { return json({ ok: false, error: '요청 본문이 올바른 JSON이 아닙니다.' }, { status: 400 }); }

  const { recordedAt, totalBytes, usedBytes } = body;
  if (!recordedAt || typeof totalBytes !== 'number' || typeof usedBytes !== 'number') {
    return json({ ok: false, error: '필수 필드 누락: recordedAt, totalBytes, usedBytes' }, { status: 400 });
  }
  if (totalBytes <= 0 || usedBytes < 0) {
    return json({ ok: false, error: `용량 값이 올바르지 않습니다. (total=${totalBytes}, used=${usedBytes})` }, { status: 400 });
  }

  try {
    await env.DB
      .prepare('INSERT INTO storage_snapshots (recorded_at, total_bytes, used_bytes) VALUES (?, ?, ?)')
      .bind(recordedAt, totalBytes, usedBytes)
      .run();
  } catch (err) {
    return json({ ok: false, error: `D1 기록 실패: ${(err as Error).message}` }, { status: 500 });
  }
  return json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/ingest/nas-status
// ═══════════════════════════════════════════════════════════════════════════

interface IngestNasBody {
  recordedAt:    string;
  totalBytes:    number | null;
  usedBytes:     number | null;
  uptimeSeconds: number | null;
  volumes:       unknown[];
  disks:         unknown[];
}

async function handleIngestNas(request: Request, env: Env): Promise<Response> {
  if (!verifyKey(request, env)) return authFail();

  let body: IngestNasBody;
  try { body = await request.json() as IngestNasBody; }
  catch { return json({ ok: false, error: '요청 본문이 올바른 JSON이 아닙니다.' }, { status: 400 }); }

  if (!body.recordedAt) {
    return json({ ok: false, error: '필수 필드 누락: recordedAt' }, { status: 400 });
  }

  try {
    await env.DB
      .prepare(`
        INSERT INTO nas_status (recorded_at, total_bytes, used_bytes, uptime_seconds, volumes_json, disks_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(
        body.recordedAt,
        body.totalBytes  ?? null,
        body.usedBytes   ?? null,
        body.uptimeSeconds ?? null,
        JSON.stringify(body.volumes ?? []),
        JSON.stringify(body.disks   ?? []),
      )
      .run();
  } catch (err) {
    return json({ ok: false, error: `D1 기록 실패: ${(err as Error).message}` }, { status: 500 });
  }
  return json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/ingest/services
// ═══════════════════════════════════════════════════════════════════════════

interface ServicePayload {
  id:           string;
  name:         string;
  category?:    string;
  status:       string;
  responseMs?:  number | null;
  httpStatus?:  number | null;
  message?:     string;
  openUrl?:     string;
}

interface IngestServicesBody {
  recordedAt: string;
  services:   ServicePayload[];
}

async function handleIngestServices(request: Request, env: Env): Promise<Response> {
  if (!verifyKey(request, env)) return authFail();

  let body: IngestServicesBody;
  try { body = await request.json() as IngestServicesBody; }
  catch { return json({ ok: false, error: '요청 본문이 올바른 JSON이 아닙니다.' }, { status: 400 }); }

  if (!body.recordedAt || !Array.isArray(body.services) || body.services.length === 0) {
    return json({ ok: false, error: '필수 필드 누락: recordedAt, services[]' }, { status: 400 });
  }

  try {
    const stmt = env.DB.prepare(`
      INSERT INTO service_status
        (recorded_at, service_id, name, category, status, response_ms, http_status, message, open_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    await env.DB.batch(
      body.services.map(s =>
        stmt.bind(
          body.recordedAt,
          s.id,
          s.name,
          s.category   ?? null,
          s.status,
          s.responseMs ?? null,
          s.httpStatus ?? null,
          s.message    ?? null,
          s.openUrl    ?? null,
        ),
      ),
    );
  } catch (err) {
    return json({ ok: false, error: `D1 기록 실패: ${(err as Error).message}` }, { status: 500 });
  }
  // 서비스 수집 완료 → 새로고침 트리거 플래그 클리어
  try {
    await env.DB
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pending_refresh', '0')")
      .run();
  } catch { /* 무시 */ }
  return json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/request-refresh  — 대시보드에서 NAS 수집 즉시 트리거
// ═══════════════════════════════════════════════════════════════════════════

async function handleRequestRefresh(env: Env): Promise<Response> {
  try {
    await env.DB
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pending_refresh', '1')")
      .run();
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: `D1 기록 실패: ${(err as Error).message}` }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/poll  — NAS 수집기가 트리거 여부 및 마지막 수집 시각 확인
// ═══════════════════════════════════════════════════════════════════════════

interface PollSettingRow  { value:       string }
interface PollSnapshotRow { recorded_at: string }

async function handlePoll(request: Request, env: Env): Promise<Response> {
  if (!verifyKey(request, env)) return authFail();
  try {
    const [pendingResult, lastResult] = await env.DB.batch<PollSettingRow | PollSnapshotRow>([
      env.DB.prepare("SELECT value FROM settings WHERE key = 'pending_refresh'"),
      env.DB.prepare("SELECT recorded_at FROM storage_snapshots ORDER BY recorded_at DESC LIMIT 1"),
    ]);
    const pendingRow = pendingResult.results[0] as PollSettingRow  | undefined;
    const lastRow    = lastResult.results[0]    as PollSnapshotRow | undefined;
    return json({
      ok:              true,
      pendingRefresh:  pendingRow?.value === '1',
      lastCollectedAt: lastRow?.recorded_at ?? null,
    }, { headers: NO_CACHE });
  } catch (err) {
    return json({ ok: false, error: `D1 조회 실패: ${(err as Error).message}` }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/storage-history
// ═══════════════════════════════════════════════════════════════════════════

interface StorageRow {
  recorded_at: string;
  total_bytes: number;
  used_bytes:  number;
}

async function handleGetHistory(request: Request, env: Env): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const daysParam        = searchParams.get('days');

  try {
    let result: D1Result<StorageRow>;

    if (daysParam) {
      const days   = Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 365);
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      result = await env.DB
        .prepare('SELECT recorded_at, total_bytes, used_bytes FROM storage_snapshots WHERE recorded_at >= ? ORDER BY recorded_at ASC')
        .bind(cutoff)
        .all<StorageRow>();
    } else {
      result = await env.DB
        .prepare('SELECT recorded_at, total_bytes, used_bytes FROM storage_snapshots ORDER BY recorded_at ASC')
        .all<StorageRow>();
    }

    const snapshots = result.results.map(r => ({
      recordedAt: r.recorded_at,
      totalBytes: r.total_bytes,
      usedBytes:  r.used_bytes,
    }));

    return json({ ok: true, snapshots }, { headers: NO_CACHE });
  } catch (err) {
    return json({ ok: false, error: `D1 조회 실패: ${(err as Error).message}` }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/nas-status
// ═══════════════════════════════════════════════════════════════════════════

interface NasRow {
  recorded_at:    string;
  total_bytes:    number | null;
  used_bytes:     number | null;
  uptime_seconds: number | null;
  volumes_json:   string | null;
  disks_json:     string | null;
}

async function handleGetNas(env: Env): Promise<Response> {
  try {
    const row = await env.DB
      .prepare('SELECT * FROM nas_status ORDER BY recorded_at DESC LIMIT 1')
      .first<NasRow>();

    if (!row) {
      return json(
        { ok: false, error: '아직 수집된 NAS 데이터가 없습니다. 수집기를 먼저 실행해 주세요.', configured: true },
        { headers: NO_CACHE },
      );
    }

    const data = {
      fetchedAt:     row.recorded_at,
      totalBytes:    row.total_bytes   ?? null,
      usedBytes:     row.used_bytes    ?? null,
      uptimeSeconds: row.uptime_seconds ?? null,
      volumes: safeParseJson(row.volumes_json, []),
      disks:   safeParseJson(row.disks_json,   []),
    };

    return json({ ok: true, data }, { headers: NO_CACHE });
  } catch (err) {
    return json({ ok: false, error: `D1 조회 실패: ${(err as Error).message}`, configured: true }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/services
// ═══════════════════════════════════════════════════════════════════════════

interface ServiceRow {
  recorded_at: string;
  service_id:  string;
  name:        string;
  category:    string | null;
  status:      string;
  response_ms: number | null;
  http_status: number | null;
  message:     string | null;
  open_url:    string | null;
}

interface FailureRow {
  service_id:     string;
  last_failed_at: string;
}

async function handleGetServices(env: Env): Promise<Response> {
  try {
    // 서비스별 최신 상태 + 서비스별 마지막 실패 시각을 한 번에 조회
    const [statusResult, failureResult] = await env.DB.batch<ServiceRow | FailureRow>([
      env.DB.prepare(`
        WITH latest AS (
          SELECT service_id, MAX(recorded_at) AS max_at
          FROM service_status
          GROUP BY service_id
        )
        SELECT ss.*
        FROM service_status ss
        JOIN latest ON ss.service_id = latest.service_id
                   AND ss.recorded_at = latest.max_at
        ORDER BY ss.service_id
      `),
      env.DB.prepare(`
        SELECT service_id, MAX(recorded_at) AS last_failed_at
        FROM service_status
        WHERE status = 'error'
        GROUP BY service_id
      `),
    ]);

    // 마지막 실패 시각 Map 구성
    const failureMap = new Map<string, string>();
    for (const row of (failureResult.results as FailureRow[])) {
      failureMap.set(row.service_id, row.last_failed_at);
    }

    const rows      = statusResult.results as ServiceRow[];
    const checkedAt = rows.length > 0 ? rows[0].recorded_at : null;

    const services = rows.map(r => ({
      id:            r.service_id,
      name:          r.name,
      category:      r.category   ?? undefined,
      status:        r.status,
      responseTimeMs: r.response_ms ?? null,
      httpStatus:    r.http_status  ?? undefined,
      message:       r.message     ?? undefined,
      openUrl:       r.open_url    ?? undefined,
      lastCheckedAt: r.recorded_at,
      lastFailedAt:  failureMap.get(r.service_id) ?? null,
    }));

    return json({ ok: true, checkedAt, services }, { headers: NO_CACHE });
  } catch (err) {
    return json({ ok: false, error: `D1 조회 실패: ${(err as Error).message}` }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/service-history
// ═══════════════════════════════════════════════════════════════════════════

interface ServiceHistoryRow {
  recorded_at: string;
  service_id:  string;
  name:        string;
  category:    string | null;
  status:      string;
  response_ms: number | null;
  http_status: number | null;
  message:     string | null;
}

async function handleGetServiceHistory(env: Env): Promise<Response> {
  try {
    const { results } = await env.DB
      .prepare(`
        SELECT recorded_at, service_id, name, category, status, response_ms, http_status, message
        FROM   service_status
        WHERE  recorded_at >= datetime('now', '-30 days')
          AND  status != 'placeholder'
        ORDER BY recorded_at DESC
        LIMIT 5000
      `)
      .all<ServiceHistoryRow>();

    const records = results.map(r => ({
      recordedAt:  r.recorded_at,
      serviceId:   r.service_id,
      name:        r.name,
      category:    r.category    ?? undefined,
      status:      r.status,
      responseMs:  r.response_ms ?? null,
      httpStatus:  r.http_status ?? null,
      message:     r.message     ?? undefined,
    }));

    return json({ ok: true, records }, { headers: NO_CACHE });
  } catch (err) {
    return json({ ok: false, error: `D1 조회 실패: ${(err as Error).message}` }, { status: 500 });
  }
}

// ─── 유틸리티 ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeParseJson(raw: string | null, fallback: any[]): any[] {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as unknown[]; }
  catch { return fallback; }
}
