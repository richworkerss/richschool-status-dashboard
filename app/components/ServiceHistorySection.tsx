'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ServiceRecord, ServiceHistoryResponse, ServiceStatusLevel } from '@/lib/types';

// ─── 날짜 · 시각 포맷 ─────────────────────────────────────────────────────

/** ISO → KST 기준 YYYY-MM-DD 키 */
function toLocalDateKey(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3_600_000);
  return d.toISOString().slice(0, 10);
}

function formatDayLabel(dateKey: string): string {
  const today     = toLocalDateKey(new Date().toISOString());
  const yesterday = toLocalDateKey(new Date(Date.now() - 86_400_000).toISOString());
  if (dateKey === today)     return '오늘';
  if (dateKey === yesterday) return '어제';

  const d = new Date(dateKey + 'T00:00:00+09:00');
  return d.toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month:    '2-digit',
    day:      '2-digit',
    weekday:  'short',
  });
}

function formatBatchTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  });
}

// ─── 상태 레벨 라벨 ──────────────────────────────────────────────────────

const statusLabelMap: Record<ServiceStatusLevel, string> = {
  normal:      '정상',
  slow:        '느림',
  error:       '오류',
  placeholder: '대기',
};

// ─── 이상 원인 추론 ──────────────────────────────────────────────────────

function inferBatchReason(records: ServiceRecord[]): string | null {
  const abnormal = records.filter(r => r.status === 'error' || r.status === 'slow');
  if (abnormal.length === 0) return null;

  // 여러 서비스 동시 영향 → 공통 원인 가능성
  if (abnormal.length >= 2) {
    const errorCount = abnormal.filter(r => r.status === 'error').length;
    const slowCount  = abnormal.filter(r => r.status === 'slow').length;
    if (errorCount >= 2) return `여러 서비스 동시 오류 (${errorCount}건)`;
    if (slowCount  >= 2) return `여러 서비스 동시 느림 (${slowCount}건)`;
    return `여러 서비스 동시 영향 (${abnormal.length}건)`;
  }

  // 단일 서비스 — 세부 정보 분석
  const r = abnormal[0];

  // HTTP 상태 코드 기반
  if (r.httpStatus !== null && r.httpStatus !== undefined) {
    if (r.httpStatus === 503) return '서비스 일시 중단 (503)';
    if (r.httpStatus === 502) return '게이트웨이 오류 (502)';
    if (r.httpStatus === 504) return '게이트웨이 타임아웃 (504)';
    if (r.httpStatus === 429) return '요청 한도 초과 (429)';
    if (r.httpStatus === 401 || r.httpStatus === 403) return `접근 거부 (${r.httpStatus})`;
    if (r.httpStatus >= 500) return `서버 오류 (${r.httpStatus})`;
    if (r.httpStatus >= 400) return `클라이언트 오류 (${r.httpStatus})`;
  }

  // 메시지 키워드 기반
  if (r.message) {
    const m = r.message.toLowerCase();
    if (m.includes('timeout') || m.includes('타임아웃') || m.includes('timed out'))
      return '연결 타임아웃';
    if (m.includes('connection refused') || m.includes('연결 거부'))
      return '연결 거부';
    if (m.includes('ssl') || m.includes('tls') || m.includes('certificate'))
      return 'SSL / TLS 오류';
    if (m.includes('dns') || m.includes('name resolution'))
      return 'DNS 조회 실패';
  }

  // 응답 시간 기반
  if (r.status === 'slow' && r.responseMs !== null) return `응답 지연 (${r.responseMs.toLocaleString()}ms)`;
  if (r.status === 'slow')  return '응답 지연';
  if (r.status === 'error') return '서비스 오류';

  return null;
}

// ─── 데이터 그루핑 ────────────────────────────────────────────────────────

type BatchEntry = {
  recordedAt: string;
  records:    ServiceRecord[];
  reason:     string | null;
};

type DayEntry = {
  date:           string;  // YYYY-MM-DD (KST)
  label:          string;  // 표시용 라벨
  batches:        BatchEntry[];
  worstByService: Map<string, ServiceStatusLevel>;
};

type DaySummary =
  | { type: 'common' }
  | { type: 'error'; count: number }
  | { type: 'slow';  count: number }
  | { type: 'normal' };

const statusRank: Record<ServiceStatusLevel, number> = {
  placeholder: 0, normal: 1, slow: 2, error: 3,
};

function groupRecords(records: ServiceRecord[]): {
  services: { id: string; name: string }[];
  days: DayEntry[];
} {
  // 서비스 목록 (placeholder 제외)
  const serviceMap = new Map<string, string>(); // id → name
  for (const r of records) {
    if (!serviceMap.has(r.serviceId)) serviceMap.set(r.serviceId, r.name);
  }
  const services = [...serviceMap.entries()].map(([id, name]) => ({ id, name }));

  // recordedAt 별 배치
  const batchMap = new Map<string, ServiceRecord[]>();
  for (const r of records) {
    const arr = batchMap.get(r.recordedAt) ?? [];
    arr.push(r);
    batchMap.set(r.recordedAt, arr);
  }

  // 날짜별 배치 묶음
  const dayMap = new Map<string, BatchEntry[]>();
  for (const [at, recs] of batchMap) {
    const dateKey = toLocalDateKey(at);
    const arr     = dayMap.get(dateKey) ?? [];
    arr.push({ recordedAt: at, records: recs, reason: inferBatchReason(recs) });
    dayMap.set(dateKey, arr);
  }

  // 날짜 내림차순, 배치 내림차순 정렬
  const days: DayEntry[] = [...dayMap.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dateKey, batches]) => {
      const sortedBatches = [...batches].sort((a, b) =>
        b.recordedAt.localeCompare(a.recordedAt),
      );

      // 서비스별 당일 최악 상태
      const worstByService = new Map<string, ServiceStatusLevel>();
      for (const batch of sortedBatches) {
        for (const r of batch.records) {
          const prev = worstByService.get(r.serviceId);
          if (!prev || statusRank[r.status] > statusRank[prev]) {
            worstByService.set(r.serviceId, r.status);
          }
        }
      }

      return { date: dateKey, label: formatDayLabel(dateKey), batches: sortedBatches, worstByService };
    });

  return { services, days };
}

function computeDaySummary(batches: BatchEntry[]): DaySummary {
  let hasCommonFault = false;
  let errorBatches   = 0;
  let slowBatches    = 0;

  for (const batch of batches) {
    const errored = batch.records.filter(r => r.status === 'error');
    const slowed  = batch.records.filter(r => r.status === 'slow');

    if (errored.length >= 2) hasCommonFault = true;
    if (errored.length > 0)  errorBatches++;
    else if (slowed.length > 0) slowBatches++;
  }

  if (hasCommonFault)      return { type: 'common' };
  if (errorBatches > 0)    return { type: 'error', count: errorBatches };
  if (slowBatches  > 0)    return { type: 'slow',  count: slowBatches  };
  return { type: 'normal' };
}

// ─── 소형 UI 컴포넌트 ─────────────────────────────────────────────────────

function StatusDot({ level }: { level: ServiceStatusLevel }) {
  return (
    <span
      className={`svc-dot svc-dot--${level}`}
      title={statusLabelMap[level]}
      aria-label={statusLabelMap[level]}
    />
  );
}

function SummaryBadge({ summary }: { summary: DaySummary }) {
  if (summary.type === 'normal') return <span className="svc-badge svc-badge--normal">정상 운영</span>;
  if (summary.type === 'common') return <span className="svc-badge svc-badge--error">공통 장애</span>;
  if (summary.type === 'error')  return <span className="svc-badge svc-badge--error">오류 {summary.count}건</span>;
  return <span className="svc-badge svc-badge--slow">느림 {summary.count}건</span>;
}

// ─── 메인 컴포넌트 ────────────────────────────────────────────────────────

export function ServiceHistorySection({ apiBase }: { apiBase: string }) {
  const [records,     setRecords]     = useState<ServiceRecord[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [fetchError,  setFetchError]  = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

  const loadData = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`${apiBase}/api/service-history`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`API 오류 (${res.status})`);
      const json: ServiceHistoryResponse = await res.json();
      if (!json.ok) throw new Error(json.error);
      setRecords(json.records);
    } catch (e) {
      setFetchError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { loadData(); }, [loadData]);

  const { services, days } = useMemo(() => groupRecords(records), [records]);

  const toggleDay = useCallback((date: string) => {
    setExpandedDays(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }, []);

  // ── 렌더링 ────────────────────────────────────────────────────────────

  return (
    <section className="svc-history-section">
      <div className="section-heading">
        <h3>서비스 가동 이력</h3>
        <p className="subtitle">
          날짜를 클릭하면 시간대별 상세 내역을 확인할 수 있습니다. (최근 30일)
        </p>
      </div>

      {loading && (
        <div className="svc-history-loading">이력을 불러오는 중...</div>
      )}

      {fetchError && !loading && (
        <div className="error-banner">서비스 이력 로드 실패: {fetchError}</div>
      )}

      {!loading && !fetchError && days.length === 0 && (
        <div className="svc-history-empty">아직 수집된 이력이 없습니다.</div>
      )}

      {!loading && !fetchError && days.length > 0 && (
        <div className="svc-history-table-wrap">
          <table className="svc-history-table">
            <thead>
              <tr>
                <th className="svc-history-th svc-history-th--date">날짜</th>
                {services.map(svc => (
                  <th key={svc.id} className="svc-history-th svc-history-th--svc">
                    <span className="svc-history-svc-name">{svc.name}</span>
                  </th>
                ))}
                <th className="svc-history-th svc-history-th--summary">요약</th>
              </tr>
            </thead>
            <tbody>
              {days.map(day => {
                const isExpanded = expandedDays.has(day.date);
                const summary    = computeDaySummary(day.batches);

                return (
                  <React.Fragment key={day.date}>
                    {/* 날짜 요약 행 */}
                    <tr
                      className={`svc-history-day-row${isExpanded ? ' svc-history-day-row--open' : ''}`}
                      onClick={() => toggleDay(day.date)}
                      role="button"
                      tabIndex={0}
                      aria-expanded={isExpanded}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleDay(day.date);
                        }
                      }}
                    >
                      <td className="svc-history-td svc-history-td--date">
                        <span className="svc-history-chevron" aria-hidden="true">
                          {isExpanded
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 7l3-4 3 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            : <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3l3 4 3-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          }
                        </span>
                        <span className="svc-history-date-label">{day.label}</span>
                        <span className="svc-history-batch-count">{day.batches.length}회 수집</span>
                      </td>
                      {services.map(svc => (
                        <td key={svc.id} className="svc-history-td svc-history-td--dot">
                          <StatusDot level={day.worstByService.get(svc.id) ?? 'normal'} />
                        </td>
                      ))}
                      <td className="svc-history-td svc-history-td--summary">
                        <SummaryBadge summary={summary} />
                      </td>
                    </tr>

                    {/* 시간대별 상세 행 */}
                    {isExpanded && day.batches.map(batch => (
                      <tr key={batch.recordedAt} className="svc-history-batch-row">
                        <td className="svc-history-td svc-history-td--time">
                          {formatBatchTime(batch.recordedAt)}
                        </td>
                        {services.map(svc => {
                          const rec = batch.records.find(r => r.serviceId === svc.id);
                          if (!rec) {
                            return (
                              <td key={svc.id} className="svc-history-td svc-history-td--cell">
                                <span className="svc-history-nodata">—</span>
                              </td>
                            );
                          }
                          return (
                            <td key={svc.id} className="svc-history-td svc-history-td--cell">
                              <div className="svc-history-cell-inner">
                                <StatusDot level={rec.status} />
                                {rec.responseMs !== null && (
                                  <span className="svc-history-ms">{rec.responseMs.toLocaleString()}ms</span>
                                )}
                              </div>
                            </td>
                          );
                        })}
                        <td className="svc-history-td svc-history-td--reason">
                          {batch.reason
                            ? <span className="svc-history-reason">{batch.reason}</span>
                            : <span className="svc-history-nodata">—</span>
                          }
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
