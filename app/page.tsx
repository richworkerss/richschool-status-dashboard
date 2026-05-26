'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getApiBase } from '@/lib/api';
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
  const [data,          setData]          = useState<HealthResponse | null>(null);
  const [isRefreshing,  setIsRefreshing]  = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [checkedAt,     setCheckedAt]     = useState<string | null>(null);
  const [nasData,       setNasData]       = useState<NasStorageResponse | null>(null);

  const apiBase = getApiBase();

  const fetchServices = useCallback(async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/services`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`서비스 상태 API 호출 실패 (${res.status})`);
      const json: HealthResponse = await res.json();
      setData(json);
      // Workers에서 반환한 수집 기준 시각을 그대로 표시합니다.
      if (json.checkedAt) setCheckedAt(json.checkedAt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsRefreshing(false);
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

  const handleRefresh = useCallback(() => {
    fetchServices();
    fetchNas();
  }, [fetchServices, fetchNas]);

  useEffect(() => {
    fetchServices();
    fetchNas();
    const id = setInterval(handleRefresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchServices, fetchNas, handleRefresh]);

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
            <span className="hero-meta-label">데이터 기준</span>
            <span className="hero-meta-value">
              {checkedAt ? formatTime(checkedAt) : '확인 중...'}
            </span>
          </div>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="refresh-button"
            aria-label="지금 상태 새로고침"
          >
            {isRefreshing ? '새로고침 중...' : '지금 새로고침'}
          </button>
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
        <NasStorageSection info={nasData.data} />
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

      <footer className="footer">
        <p>본 대시보드는 사내 운영팀의 빠른 상태 확인을 위해 제공됩니다.</p>
      </footer>
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

function NasStorageSection({ info }: { info: NasStorageInfo }) {
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
        <Link href="/storage-history" className="nas-history-link">
          사용량 히스토리 →
        </Link>
      </div>

      <div className={`nas-summary-card nas-summary-${barLevel}`}>
        <div className="nas-summary-header">
          <div className="nas-summary-title-block">
            <span className="nas-summary-title">전체 저장소 사용 현황</span>
            <span className="nas-summary-sub">
              볼륨 {info.volumes.length}개 · 디스크 {info.disks.length}개
              {info.uptimeSeconds != null && ` · 업타임 ${formatUptime(info.uptimeSeconds)}`}
            </span>
          </div>
          {usagePct != null
            ? <span className={`nas-usage-pct nas-usage-pct-${barLevel}`}>{usagePct}%</span>
            : <span className="nas-usage-pct nas-usage-pct-unknown">—</span>
          }
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
