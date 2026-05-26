'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBase } from '@/lib/api';
import type { StorageHistoryResponse, StorageSnapshot } from '@/lib/types';

// ─── 포맷 유틸리티 ────────────────────────────────────────────────────────

function fmtBytes(b: number | null | undefined): string {
  if (b == null || b <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
  return `${i === 0 ? String(b) : (b / 1024 ** i).toFixed(1)} ${u[i]}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

function fmtDateShort(ms: number): string {
  return new Date(ms).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' });
}

function fmtDateLong(date: Date): string {
  return date.toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

function daysFromNow(date: Date): number {
  return Math.round((date.getTime() - Date.now()) / 86_400_000);
}

// ─── 선형 회귀 + 예측 ─────────────────────────────────────────────────────

type Predictions = {
  dailyIncreaseBytes: number;
  date75:   Date | null;
  date85:   Date | null;
  date90:   Date | null;
  currentPct: number;
  totalBytes: number;
  noGrowth: boolean;
};

function computePredictions(snapshots: StorageSnapshot[]): Predictions | null {
  if (snapshots.length < 3) return null;

  const latest = snapshots[snapshots.length - 1];
  const total  = latest.totalBytes;
  if (!total || total <= 0) return null;

  const currentPct = (latest.usedBytes / total) * 100;

  const xs = snapshots.map(s => new Date(s.recordedAt).getTime() / 86_400_000);
  const ys = snapshots.map(s => s.usedBytes);
  const n  = xs.length;
  const sx  = xs.reduce((a, v) => a + v, 0);
  const sy  = ys.reduce((a, v) => a + v, 0);
  const sxy = xs.reduce((a, v, i) => a + v * ys[i], 0);
  const sxx = xs.reduce((a, v) => a + v * v, 0);
  const den = n * sxx - sx * sx;
  if (den === 0) return null;

  const m = (n * sxy - sx * sy) / den;
  const b = (sy - m * sx) / n;

  if (m <= 0) {
    return { dailyIncreaseBytes: m, date75: null, date85: null, date90: null,
      noGrowth: true, currentPct, totalBytes: total };
  }

  const nowDays = Date.now() / 86_400_000;
  const toDate  = (thr: number): Date | null => {
    const rem = (total * thr - (m * nowDays + b)) / m;
    return rem > 0 ? new Date(Date.now() + rem * 86_400_000) : null;
  };

  return {
    dailyIncreaseBytes: m,
    date75: toDate(0.75),
    date85: toDate(0.85),
    date90: toDate(0.90),
    noGrowth: false,
    currentPct,
    totalBytes: total,
  };
}

// ─── SVG 차트 ─────────────────────────────────────────────────────────────

const VB_W = 960;
const VB_H = 300;
const PAD  = { t: 14, r: 24, b: 46, l: 56 } as const;
const CW   = VB_W - PAD.l - PAD.r;
const CH   = VB_H - PAD.t - PAD.b;

function scaleY(pct: number): number {
  return PAD.t + CH * (1 - pct / 100);
}

function StorageChart({ snapshots }: { snapshots: StorageSnapshot[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [tip,     setTip]     = useState({ x: 0, y: 0 });
  const wrapRef               = useRef<HTMLDivElement>(null);
  const svgRef                = useRef<SVGSVGElement>(null);

  if (snapshots.length < 2) {
    return (
      <div className="history-chart-empty">
        <p>사용량 추이 그래프를 표시하려면 최소 2개 이상의 기록이 필요합니다.</p>
        <p className="history-chart-empty-sub">
          현재 {snapshots.length}개 기록됨 — 수집기(cron)가 1시간 간격으로 자동 기록합니다.
        </p>
      </div>
    );
  }

  const latest     = snapshots[snapshots.length - 1];
  const totalBytes = latest.totalBytes;
  const tss        = snapshots.map(s => new Date(s.recordedAt).getTime());
  const minTs      = tss[0];
  const maxTs      = tss[tss.length - 1];
  const tsRange    = maxTs - minTs || 1;

  const scaleX = (ts: number) => PAD.l + ((ts - minTs) / tsRange) * CW;

  const pts = snapshots.map((s, i) => ({
    i,
    x:   scaleX(tss[i]),
    pct: totalBytes > 0 ? (s.usedBytes / totalBytes) * 100 : 0,
    ...s,
  }));

  const coords   = pts.map(p => `${p.x},${scaleY(p.pct)}`).join(' L ');
  const linePath = `M ${coords}`;
  const bottom   = PAD.t + CH;
  const areaPath = `M ${coords} L ${pts[pts.length - 1].x},${bottom} L ${pts[0].x},${bottom} Z`;

  const maxTicks = Math.min(pts.length, 6);
  const tickIdxs: number[] = [];
  if (pts.length <= maxTicks) {
    pts.forEach((_, i) => tickIdxs.push(i));
  } else {
    const step = (pts.length - 1) / (maxTicks - 1);
    for (let k = 0; k < maxTicks - 1; k++) tickIdxs.push(Math.round(k * step));
    tickIdxs.push(pts.length - 1);
  }

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || !wrapRef.current) return;
    const r    = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - r.left) / r.width) * VB_W;
    let closestI = 0, minD = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(p.x - svgX); if (d < minD) { minD = d; closestI = i; } });
    setHovered(closestI);
    const wr = wrapRef.current.getBoundingClientRect();
    setTip({ x: e.clientX - wr.left, y: e.clientY - wr.top });
  };

  const hp = hovered !== null ? pts[hovered] : null;

  return (
    <div ref={wrapRef} className="history-chart-svg-wrap">
      <svg ref={svgRef} viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="xMidYMid meet" className="history-svg"
        onMouseMove={handleMouseMove} onMouseLeave={() => setHovered(null)}
        aria-label="저장소 사용량 추이 그래프" role="img">
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#3b82f6" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
          </linearGradient>
          <clipPath id="chartClip">
            <rect x={PAD.l} y={PAD.t} width={CW} height={CH} />
          </clipPath>
        </defs>

        <rect x={PAD.l} y={scaleY(90)}  width={CW} height={scaleY(100) - scaleY(90)} fill="rgba(220,38,38,0.055)" />
        <rect x={PAD.l} y={scaleY(75)}  width={CW} height={scaleY(90)  - scaleY(75)} fill="rgba(217,119,6,0.055)" />

        {([0, 25, 50, 75, 90, 100] as const).map(pct => {
          const isT = pct === 75 || pct === 90;
          return (
            <g key={pct}>
              <line x1={PAD.l} y1={scaleY(pct)} x2={PAD.l + CW} y2={scaleY(pct)}
                stroke={pct === 75 ? 'rgba(217,119,6,0.5)' : pct === 90 ? 'rgba(220,38,38,0.5)' : 'rgba(0,0,0,0.07)'}
                strokeWidth={isT ? 1.5 : 1} strokeDasharray={isT ? '5 4' : undefined} />
              <text x={PAD.l - 8} y={scaleY(pct)} textAnchor="end" dominantBaseline="middle"
                fontSize="11"
                fill={pct === 75 ? '#d97706' : pct === 90 ? '#dc2626' : '#9ca3af'}
                fontWeight={isT ? '700' : '400'}>
                {pct}%
              </text>
            </g>
          );
        })}

        {tickIdxs.map(i => (
          <text key={i} x={pts[i].x} y={PAD.t + CH + 18}
            textAnchor="middle" fontSize="11" fill="#9ca3af">
            {fmtDateShort(tss[i])}
          </text>
        ))}

        <g clipPath="url(#chartClip)">
          <path d={areaPath} fill="url(#areaGrad)" />
          <path d={linePath} fill="none" stroke="#3b82f6" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round" />
          {hp && (
            <line x1={hp.x} y1={PAD.t} x2={hp.x} y2={PAD.t + CH}
              stroke="rgba(0,0,0,0.12)" strokeWidth="1.5" strokeDasharray="4 3" />
          )}
          {pts.map(p => {
            const isLast = p.i === pts.length - 1;
            const isHov  = p.i === hovered;
            if (!isLast && !isHov) return null;
            return (
              <circle key={p.i} cx={p.x} cy={scaleY(p.pct)}
                r={isHov ? 5 : 4}
                fill={isHov ? '#2563eb' : '#3b82f6'}
                stroke="#fff" strokeWidth="2.5" />
            );
          })}
        </g>

        <rect x={PAD.l} y={PAD.t} width={CW} height={CH}
          fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth="1" />
      </svg>

      {hp && (
        <div className="history-tooltip" style={{ left: tip.x + 14, top: tip.y - 80 }}>
          <div className="history-tooltip-date">{fmtDate(hp.recordedAt)}</div>
          <div className="history-tooltip-row">
            <span>사용률</span><strong>{hp.pct.toFixed(1)}%</strong>
          </div>
          <div className="history-tooltip-row">
            <span>사용 중</span><strong>{fmtBytes(hp.usedBytes)}</strong>
          </div>
          <div className="history-tooltip-row">
            <span>여유</span><strong>{fmtBytes(hp.totalBytes - hp.usedBytes)}</strong>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 예측 카드 ────────────────────────────────────────────────────────────

function PredictionCard({ title, date, color, icon, desc }: {
  title: string; date: Date | null; color: 'warn' | 'error' | 'neutral'; icon: string; desc: string;
}) {
  const days   = date ? daysFromNow(date) : null;
  const isPast = days != null && days < 0;
  return (
    <div className={`prediction-card prediction-card-${color}`}>
      <div className="prediction-card-icon" aria-hidden="true">{icon}</div>
      <div className="prediction-card-title">{title}</div>
      {date ? (
        <>
          <div className={`prediction-card-date${isPast ? ' prediction-past' : ''}`}>
            {isPast ? '이미 초과됨' : fmtDateLong(date)}
          </div>
          {!isPast && days != null && (
            <div className="prediction-card-days">약 {days}일 후 (추정)</div>
          )}
        </>
      ) : (
        <div className="prediction-card-date prediction-na">해당 없음</div>
      )}
      <div className="prediction-card-desc">{desc}</div>
    </div>
  );
}

// ─── 메인 페이지 ──────────────────────────────────────────────────────────

export default function StorageHistoryPage() {
  const [snapshots, setSnapshots] = useState<StorageSnapshot[] | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [fetchErr,  setFetchErr]  = useState<string | null>(null);

  const apiBase = getApiBase();

  const load = useCallback(async () => {
    setLoading(true);
    setFetchErr(null);
    try {
      const res  = await fetch(`${apiBase}/api/storage-history`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`API 오류 (${res.status})`);
      const json: StorageHistoryResponse = await res.json();
      if (!json.ok) throw new Error(json.error);
      setSnapshots(json.snapshots);
    } catch (e) {
      setFetchErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { load(); }, [load]);

  const pred  = useMemo(() => snapshots ? computePredictions(snapshots) : null, [snapshots]);
  const first = snapshots?.[0] ?? null;
  const last  = snapshots?.[snapshots.length - 1] ?? null;

  const avgDailyIncrease: number | null = useMemo(() => {
    if (!snapshots || snapshots.length < 2 || !first || !last) return null;
    const days = (new Date(last.recordedAt).getTime() - new Date(first.recordedAt).getTime()) / 86_400_000;
    if (days <= 0) return null;
    return (last.usedBytes - first.usedBytes) / days;
  }, [snapshots, first, last]);

  return (
    <main className="container">
      <header className="top-bar">
        <div>
          <Link href="/" className="history-back-link">← 대시보드로 돌아가기</Link>
          <h1>저장소 사용량 히스토리</h1>
          <p className="subtitle">NAS 용량 사용 추이 및 증가 예측 — 전체 누적 기록 기준</p>
        </div>
      </header>

      {fetchErr && <div className="error-banner">{fetchErr}</div>}

      <div className="history-chart-card">
        <div className="history-chart-header">
          <div>
            <span className="history-chart-title">사용량 추이</span>
            {last && last.totalBytes > 0 && (
              <span className="history-chart-subtitle">
                전체 용량 기준 {fmtBytes(last.totalBytes)}
              </span>
            )}
          </div>
          {loading && <span className="history-chart-loading-badge">갱신 중…</span>}
        </div>

        {loading && !snapshots ? (
          <div className="history-loading">데이터를 불러오는 중입니다…</div>
        ) : snapshots ? (
          <StorageChart snapshots={snapshots} />
        ) : null}
      </div>

      {snapshots && snapshots.length > 0 && last && (
        <div className="history-stats-grid">
          <div className="history-stat-card">
            <div className="history-stat-label">일일 평균 증가량</div>
            <div className="history-stat-value">
              {avgDailyIncrease == null ? '—'
                : avgDailyIncrease > 0
                  ? `+${fmtBytes(avgDailyIncrease)}`
                  : fmtBytes(Math.abs(avgDailyIncrease))}
            </div>
            <div className="history-stat-sub">전체 기간 기준</div>
          </div>

          <div className="history-stat-card">
            <div className="history-stat-label">현재 사용률</div>
            <div className={`history-stat-value${
              pred
                ? pred.currentPct >= 90 ? ' pct-error'
                : pred.currentPct >= 75 ? ' pct-warn'
                : ' pct-ok'
              : ''
            }`}>
              {pred ? `${pred.currentPct.toFixed(1)}%` : '—'}
            </div>
            <div className="history-stat-sub">
              {fmtBytes(last.usedBytes)} / {fmtBytes(last.totalBytes)}
            </div>
          </div>

          <div className="history-stat-card">
            <div className="history-stat-label">기간 내 총 증가량</div>
            <div className="history-stat-value">
              {snapshots.length >= 2 && first
                ? `+${fmtBytes(Math.max(0, last.usedBytes - first.usedBytes))}`
                : '—'}
            </div>
            <div className="history-stat-sub">
              {first ? `${fmtDate(first.recordedAt)}부터` : ''}
            </div>
          </div>

          <div className="history-stat-card">
            <div className="history-stat-label">기록 수</div>
            <div className="history-stat-value">{snapshots.length}개</div>
            <div className="history-stat-sub">누적 스냅샷</div>
          </div>
        </div>
      )}

      {pred && !pred.noGrowth && (
        <section className="prediction-section">
          <div className="prediction-section-header">
            <h2>용량 도달 예측</h2>
            <p className="prediction-disclaimer">
              누적 데이터의 선형 증가 추세를 기반으로 한 추정치입니다. 실제 사용 패턴에 따라 달라질 수 있으며 확정 일정이 아닙니다.
            </p>
          </div>
          <div className="prediction-grid">
            <PredictionCard title="75% 도달 예상"  date={pred.date75} color="warn"    icon="⚠️"  desc="저장소 주의 수위 도달 예상 시점" />
            <PredictionCard title="90% 도달 예상"  date={pred.date90} color="error"   icon="🚨"  desc="저장소 위험 수위 도달 예상 시점" />
            <PredictionCard title="백업 권장 시점"  date={pred.date85} color="warn"    icon="💾"  desc="85% 도달 전 — 본격 백업 준비 권장" />
            <PredictionCard title="증설 검토 시점"  date={pred.date75} color="neutral" icon="💿"  desc="75% 도달 시점 기준 — 증설 계획 시작 권장" />
          </div>
        </section>
      )}

      {pred?.noGrowth && (
        <div className="prediction-notice prediction-no-growth">
          증가 추세 없음 — 사용량이 감소하거나 변동이 없어 예측을 표시하지 않습니다.
        </div>
      )}

      {snapshots && snapshots.length < 3 && snapshots.length > 0 && (
        <div className="prediction-notice">
          <strong>예측 데이터 수집 중</strong> — 예측 표시에는 최소 3개의 기록이 필요합니다
          (현재 {snapshots.length}개). 수집기(cron)가 1시간마다 자동으로 기록합니다.
        </div>
      )}

      {snapshots?.length === 0 && !loading && (
        <div className="prediction-notice">
          아직 기록된 데이터가 없습니다. 수집기(<code>npm run push-to-cf</code>)를 실행하면 기록이 시작됩니다.
        </div>
      )}

      <footer className="footer">
        <p>사용량은 수집기(cron)에 의해 1시간마다 Cloudflare D1에 자동 기록됩니다.</p>
      </footer>
    </main>
  );
}
