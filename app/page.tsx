'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBase } from '@/lib/api';
import { NasHistoryTab } from '@/app/components/NasHistoryTab';
import { ServiceHistorySection } from '@/app/components/ServiceHistorySection';
import type {
  HealthResponse,
  NasDisk,
  NasHealthLevel,
  NasStorageInfo,
  NasStorageResponse,
  NasVolume,
  ServiceStatus,
  ServiceStatusLevel,
} from '@/lib/types';

const REFRESH_INTERVAL_MS = 30_000;

type OverallLevel = 'normal' | 'slow' | 'error' | 'loading';

const overallTitle: Record<OverallLevel, string> = {
  normal:  '정상',
  slow:    '느림',
  error:   '오류',
  loading: '확인 중',
};

const overallDescription: Record<OverallLevel, string> = {
  normal:  '모든 핵심 서비스가 정상적으로 응답하고 있습니다.',
  slow:    '일부 서비스 응답이 평소보다 느립니다. 상태를 확인해 주세요.',
  error:   '하나 이상의 핵심 서비스에 문제가 있습니다. 즉시 확인이 필요합니다.',
  loading: '서비스 상태를 확인하는 중입니다...',
};

const statusLabel: Record<ServiceStatusLevel, string> = {
  normal:      '정상',
  slow:        '느림',
  error:       '오류',
  placeholder: '대기',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', {
    hour12: false,
    year:   'numeric',
    month:  '2-digit',
    day:    '2-digit',
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분`;
  return '방금 시작됨';
}

function computeOverall(services: ServiceStatus[]): OverallLevel {
  const real = services.filter((s) => s.status !== 'placeholder');
  if (real.length === 0) return 'loading';
  if (real.some((s) => s.status === 'error')) return 'error';
  if (real.some((s) => s.status === 'slow'))  return 'slow';
  return 'normal';
}

export default function DashboardPage() {
  const [data,           setData]           = useState<HealthResponse | null>(null);
  const [isRefreshing,   setIsRefreshing]   = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [showToast,      setShowToast]      = useState(false);
  const [toastKey,       setToastKey]       = useState(0);
  const [error,          setError]          = useState<string | null>(null);
  const [checkedAt,      setCheckedAt]      = useState<string | null>(null);
  const [nasData,        setNasData]        = useState<NasStorageResponse | null>(null);

  const apiBase          = getApiBase();
  const toastTimer       = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [refreshElapsed, setRefreshElapsed] = useState(0);

  const triggerToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastKey(k => k + 1); // 매번 새 key → 애니메이션 재시작 보장
    setShowToast(true);
    toastTimer.current = setTimeout(() => setShowToast(false), 3_000);
  }, []);

  const fetchServices = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/services`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`서비스 상태 API 호출 실패 (${res.status})`);
      const json: HealthResponse = await res.json();
      setData(json);
      if (json.checkedAt) setCheckedAt(json.checkedAt);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [apiBase]);

  const fetchNas = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/nas-status`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`NAS API 호출 실패 (${res.status})`);
      const json: NasStorageResponse = await res.json();
      setNasData(json);
    } catch (e) {
      setNasData({ ok: false, error: (e as Error).message, configured: true });
    }
  }, [apiBase]);

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setError(null);
    setRefreshElapsed(0);

    // 카운트다운 진행 바: 1초마다 elapsed 증가
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      setRefreshElapsed(e => e + 1);
    }, 1_000);

    const prevCheckedAt = checkedAt;

    try {
      // 1. Workers에 수집 트리거 전송
      setRefreshMessage('1분만 기다려주세요');
      const triggerRes = await fetch(`${apiBase}/api/request-refresh`, {
        method: 'POST', cache: 'no-store',
      });

      if (!triggerRes.ok) throw new Error('trigger_failed');

      // 2. NAS 수집기가 응답할 때까지 폴링 (최대 90초, 3초 간격)
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise<void>(r => setTimeout(r, 3_000));
        try {
          const res  = await fetch(`${apiBase}/api/services`, { cache: 'no-store' });
          if (!res.ok) continue;
          const json: HealthResponse = await res.json();
          const isNew = prevCheckedAt
            ? json.checkedAt && json.checkedAt > prevCheckedAt
            : !!json.checkedAt;
          if (isNew) {
            setData(json);
            if (json.checkedAt) setCheckedAt(json.checkedAt);
            fetchNas();
            triggerToast();
            return;
          }
        } catch { continue; }
      }
      // 타임아웃 — 그냥 현재 상태 표시
    } catch {
      // 트리거 실패(로컬 개발 등) → 직접 새로고침
      await fetchServices();
      await fetchNas();
    } finally {
      if (progressTimerRef.current) {
        clearInterval(progressTimerRef.current);
        progressTimerRef.current = null;
      }
      setIsRefreshing(false);
      setRefreshMessage(null);
      setRefreshElapsed(0);
    }
  }, [apiBase, checkedAt, isRefreshing, fetchServices, fetchNas, triggerToast]);

  useEffect(() => {
    fetchServices();
    fetchNas();
    // 백그라운드 자동 갱신: D1 최신 데이터를 읽어오는 것만 수행 (NAS 수집 트리거 없음)
    const id = setInterval(() => {
      fetchServices();
      fetchNas();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchServices, fetchNas]);

  const overall: OverallLevel = useMemo(
    () => (data ? computeOverall(data.services) : 'loading'),
    [data],
  );

  const visibleServices = useMemo(
    () => (data ? data.services.filter((s) => s.status !== 'placeholder') : []),
    [data],
  );

  return (
    <main className="container">
      <header className="top-bar">
        <div>
          <h1>Richschool 시스템 상태</h1>
          <p className="subtitle">
            사내 주요 서비스의 현재 상태를 확인합니다.
          </p>
        </div>
      </header>

      <section className={`hero hero-${overall}`} aria-live="polite">
        <div className="hero-toolbar">
          <div className="hero-meta-block">
            <span className="hero-meta-label">마지막 확인시간</span>
            <span className="hero-meta-value">
              {checkedAt ? formatTime(checkedAt) : '확인 중...'}
            </span>
          </div>
          <div className="refresh-button-wrap">
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className={`refresh-button${isRefreshing ? ' refresh-button--loading' : ''}`}
              aria-label="지금 상태 새로고침"
            >
              {isRefreshing && <span className="refresh-spinner" aria-hidden="true" />}
              {refreshMessage ?? (isRefreshing ? '새로고침 중...' : '새로고침')}
            </button>
            {isRefreshing && (
              <div className="refresh-progress-container">
                <div className="refresh-progress-track">
                  <div
                    className="refresh-progress-fill"
                    style={{ width: `${Math.min(90, (refreshElapsed / 60) * 100)}%` }}
                  />
                </div>
                <span className="refresh-progress-label">
                  {refreshElapsed < 57
                    ? `약 ${60 - refreshElapsed}초 남음`
                    : '곧 완료됩니다...'}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="hero-light">
          <span className="hero-light-disc">
            <StatusGlyph level={overall} />
          </span>
        </div>
        <div className="hero-text">
          <p className="hero-label">현재 전체 시스템 상태</p>
          <h2 className="hero-title">{overallTitle[overall]}</h2>
          <p className="hero-description">{overallDescription[overall]}</p>
        </div>
        {visibleServices.length > 0 && (
          <div className="hero-service-chips">
            {visibleServices.map((s) => (
              <ServiceStatusChip key={s.id} service={s} />
            ))}
          </div>
        )}
      </section>

      {error && (
        <div className="error-banner">상태 정보를 불러올 수 없습니다: {error}</div>
      )}

      {nasData && nasData.ok && (
        <NasStorageSection info={nasData.data} apiBase={apiBase} />
      )}
      {nasData && !nasData.ok && nasData.configured && (
        <div className="error-banner nas-error-banner">
          NAS 저장소 정보를 불러올 수 없습니다: {nasData.error}
        </div>
      )}

      <section className="section-heading">
        <h3>서비스별 상세 상태</h3>
        <p className="subtitle">각 서비스의 응답 시간, 오류 코드 등 세부 진단 정보입니다.</p>
      </section>

      <section className="grid">
        {!data && !error && (
          <div className="loading">서비스 상태를 불러오는 중입니다...</div>
        )}
        {data && visibleServices.length === 0 && !error && (
          <div className="loading">표시할 서비스가 없습니다.</div>
        )}
        {visibleServices.map((s) => (
          <StatusCard key={s.id} service={s} />
        ))}
      </section>

      <ServiceHistorySection apiBase={apiBase} />

      <footer className="footer">
        <p>본 대시보드는 사내 운영팀의 빠른 상태 확인을 위해 제공됩니다.</p>
      </footer>

      {showToast && (
        <div key={toastKey} className="toast" role="status" aria-live="polite">
          <span className="toast-icon">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1.5 5l2.5 2.5 4.5-5" stroke="#fff" strokeWidth="1.6"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          업데이트가 완료되었습니다
        </div>
      )}
    </main>
  );
}

function StatusGlyph({ level }: { level: OverallLevel | ServiceStatusLevel }) {
  if (level === 'normal') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor"
          strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (level === 'slow') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12.5" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path d="M12 8v5l3 2" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (level === 'error') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor"
          strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6.5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12"  cy="12" r="1.5" fill="currentColor" />
      <circle cx="17.5" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

function StatusCard({ service }: { service: ServiceStatus }) {
  const body = (
    <>
      <header className="card-header">
        <div className="card-title">
          {service.category && <span className="card-category">{service.category}</span>}
          <h2 className="card-name">{service.name}</h2>
        </div>
        <StatusBadge level={service.status} />
      </header>

      {service.message && (
        <p className={`card-summary card-summary-${service.status}`}>{service.message}</p>
      )}

      <dl className="card-meta">
        <div>
          <dt>응답 시간</dt>
          <dd>{service.responseTimeMs == null ? '—' : `${service.responseTimeMs} ms`}</dd>
        </div>
        <div>
          <dt>마지막 확인</dt>
          <dd>{formatTime(service.lastCheckedAt)}</dd>
        </div>
        <div className="card-meta-secondary">
          <dt>HTTP 상태</dt>
          <dd>{service.httpStatus ?? '—'}</dd>
        </div>
        <div className="card-meta-full card-meta-secondary">
          <dt>마지막 실패</dt>
          <dd>{service.lastFailedAt ? formatTime(service.lastFailedAt) : '없음'}</dd>
        </div>
      </dl>
    </>
  );

  if (service.openUrl) {
    return (
      <a href={service.openUrl} target="_blank" rel="noopener noreferrer"
        className={`card card-link card-${service.status}`}
        aria-label={`${service.name} 새 탭에서 열기`}>
        {body}
      </a>
    );
  }
  return <article className={`card card-${service.status}`}>{body}</article>;
}

function StatusBadge({ level }: { level: ServiceStatusLevel }) {
  return (
    <span className={`badge badge-${level}`}>
      <span className="badge-dot" />
      {statusLabel[level]}
    </span>
  );
}

function ServiceStatusChip({ service }: { service: ServiceStatus }) {
  return (
    <span className={`service-chip service-chip-${service.status}`}>
      <span className="chip-dot" aria-hidden="true" />
      <span className="chip-name">{service.name}</span>
      <span className="chip-label">{statusLabel[service.status]}</span>
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   NAS 저장소 섹션
   ───────────────────────────────────────────────────────────────────────────── */

const nasHealthLabel: Record<NasHealthLevel, string> = {
  normal:  '정상',
  warning: '주의',
  error:   '오류',
  unknown: '알 수 없음',
};

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i   = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = i === 0 ? String(bytes) : (bytes / Math.pow(1024, i)).toFixed(1);
  return `${val} ${units[i]}`;
}

function NasStorageSection({ info, apiBase }: { info: NasStorageInfo; apiBase: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const usagePct: number | null =
    info.totalBytes != null && info.totalBytes > 0 && info.usedBytes != null
      ? Math.round((info.usedBytes / info.totalBytes) * 100)
      : null;
  const freeBytes: number | null =
    info.totalBytes != null && info.usedBytes != null
      ? Math.max(0, info.totalBytes - info.usedBytes)
      : null;

  const barLevel: NasHealthLevel =
    usagePct == null ? 'unknown' :
    usagePct >= 90   ? 'error'   :
    usagePct >= 75   ? 'warning' :
    'normal';

  return (
    <section className="nas-section">
      <div className="section-heading nas-section-heading">
        <div>
          <h3>NAS 저장소 상태</h3>
          <p className="subtitle">NAS 볼륨과 디스크의 현재 상태를 보여줍니다.</p>
        </div>
      </div>

      {/* ── 사용 현황 카드 (클릭으로 상세 펼치기) ── */}
      <div
        className={`nas-summary-card nas-summary-${barLevel} nas-summary-expandable${isExpanded ? ' nas-summary-open' : ''}`}
        onClick={() => setIsExpanded(v => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsExpanded(v => !v); } }}
      >
        <div className="nas-summary-header">
          <div className="nas-summary-title-block">
            <span className="nas-summary-title">전체 저장소 사용 현황</span>
            <span className="nas-summary-sub">
              볼륨 {info.volumes.length}개 · 디스크 {info.disks.length}개
              {info.uptimeSeconds != null && ` · 업타임 ${formatUptime(info.uptimeSeconds)}`}
            </span>
          </div>
          <div className="nas-summary-right">
            {usagePct != null
              ? <span className={`nas-usage-pct nas-usage-pct-${barLevel}`}>{usagePct}%</span>
              : <span className="nas-usage-pct nas-usage-pct-unknown">—</span>
            }
            <span className="nas-expand-indicator" aria-hidden="true">
              {isExpanded
                ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 9.5l5-5 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                : <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4.5l5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              }
              <span>{isExpanded ? '접기' : '펼치기'}</span>
            </span>
          </div>
        </div>
        <div className="nas-progress-outer">
          <div
            className="nas-progress-track"
            aria-label={usagePct != null ? `사용률 ${usagePct}%` : '사용률 정보 없음'}
          >
            {usagePct != null && (
              <div className={`nas-progress-fill nas-progress-fill-${barLevel}`}
                style={{ width: `${usagePct}%` }} />
            )}
          </div>
          <div className="nas-threshold-marker nas-threshold-75"
            style={{ left: '75%' }} data-tooltip="저장 공간 주의 구간">
            <span className="nas-threshold-label">75%</span>
            <div className="nas-threshold-line" />
          </div>
          <div className="nas-threshold-marker nas-threshold-90"
            style={{ left: '90%' }} data-tooltip="저장 공간 경고 구간">
            <span className="nas-threshold-label">90%</span>
            <div className="nas-threshold-line" />
          </div>
        </div>
        <dl className="nas-summary-meta">
          <div><dt>사용 중</dt>  <dd>{formatBytes(info.usedBytes)}</dd></div>
          <div><dt>남은 용량</dt><dd>{formatBytes(freeBytes)}</dd></div>
          <div><dt>전체 용량</dt><dd>{formatBytes(info.totalBytes)}</dd></div>
        </dl>
      </div>

      {/* ── 펼쳐진 상세 분석 영역 ── */}
      {isExpanded && (
        <div className="nas-expanded-area">
          <NasHistoryTab apiBase={apiBase} />
        </div>
      )}

      {info.volumes.length > 0 && <NasVolumeTable volumes={info.volumes} />}
      {info.disks.length   > 0 && <NasDiskTable   disks={info.disks}   />}
    </section>
  );
}

function NasVolumeTable({ volumes }: { volumes: NasVolume[] }) {
  return (
    <div className="nas-info-card">
      <div className="nas-info-card-title">볼륨 상태</div>
      <div className="nas-table-wrap">
        <table className="nas-table">
          <thead>
            <tr>
              <th>이름</th><th>상태</th><th>파일시스템</th>
              <th>사용률</th><th>전체 용량</th><th>사용 중</th>
            </tr>
          </thead>
          <tbody>
            {volumes.map((v) => {
              const usagePct: number | null =
                v.totalBytes != null && v.totalBytes > 0 && v.usedBytes != null
                  ? Math.round((v.usedBytes / v.totalBytes) * 100) : null;
              return (
                <tr key={v.id}>
                  <td className="nas-cell-name">{v.name}</td>
                  <td><NasHealthBadge level={v.status} /></td>
                  <td className="nas-cell-muted">{v.filesystem || '—'}</td>
                  <td>{usagePct != null ? `${usagePct}%` : '—'}</td>
                  <td>{formatBytes(v.totalBytes)}</td>
                  <td>{formatBytes(v.usedBytes)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NasDiskTable({ disks }: { disks: NasDisk[] }) {
  return (
    <div className="nas-info-card">
      <div className="nas-info-card-title">디스크 현황</div>
      <div className="nas-table-wrap">
        <table className="nas-table">
          <thead>
            <tr>
              <th>이름</th><th>모델명</th><th>용량</th><th>온도</th><th>상태</th>
            </tr>
          </thead>
          <tbody>
            {disks.map((d) => {
              const tempLevel: NasHealthLevel =
                d.temperatureC == null ? 'unknown' :
                d.temperatureC >= 56   ? 'error'   :
                d.temperatureC >= 46   ? 'warning' : 'normal';
              return (
                <tr key={d.id}>
                  <td className="nas-cell-name">{d.name}</td>
                  <td className="nas-cell-model">{d.model || '—'}</td>
                  <td>{formatBytes(d.capacityBytes)}</td>
                  <td className={`nas-temp nas-temp-${tempLevel}`}>
                    {d.temperatureC != null ? `${d.temperatureC}°C` : '—'}
                  </td>
                  <td><NasHealthBadge level={d.health} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NasHealthBadge({ level }: { level: NasHealthLevel }) {
  return (
    <span className={`nas-badge nas-badge-${level}`}>
      <span className="badge-dot" />
      {nasHealthLabel[level]}
    </span>
  );
}
