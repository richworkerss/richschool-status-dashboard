-- ─────────────────────────────────────────────────────────────────────────────
-- Richschool Status Dashboard — D1 스키마
--
-- 적용 방법 (처음 또는 테이블 추가 후 다시 실행):
--   cd workers
--   npm run db:init          # 원격 D1 (배포 환경)
--   npm run db:init:local    # 로컬 D1 (wrangler dev 환경)
--
-- 모든 CREATE 문에 IF NOT EXISTS가 포함되어 있으므로
-- 기존 데이터를 건드리지 않고 안전하게 재실행할 수 있습니다.
-- ─────────────────────────────────────────────────────────────────────────────

-- ① 저장소 스냅샷 (data/storage-history.json 대체)
CREATE TABLE IF NOT EXISTS storage_snapshots (
  id          INTEGER  PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT     NOT NULL,   -- ISO 8601  예) "2026-05-26T07:00:00.000Z"
  total_bytes INTEGER  NOT NULL,
  used_bytes  INTEGER  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ss_recorded_at
  ON storage_snapshots(recorded_at DESC);

-- ② NAS 전체 상태 스냅샷 (볼륨·디스크·업타임 포함)
CREATE TABLE IF NOT EXISTS nas_status (
  id             INTEGER  PRIMARY KEY AUTOINCREMENT,
  recorded_at    TEXT     NOT NULL,
  total_bytes    INTEGER,
  used_bytes     INTEGER,
  uptime_seconds INTEGER,
  volumes_json   TEXT,   -- JSON 직렬화된 NasVolume[]
  disks_json     TEXT    -- JSON 직렬화된 NasDisk[]
);
CREATE INDEX IF NOT EXISTS idx_nas_recorded_at
  ON nas_status(recorded_at DESC);

-- ③ 서비스 헬스 상태 (배치 단위로 기록)
CREATE TABLE IF NOT EXISTS service_status (
  id           INTEGER  PRIMARY KEY AUTOINCREMENT,
  recorded_at  TEXT     NOT NULL,   -- 배치 기록 시각 (같은 배치는 동일)
  service_id   TEXT     NOT NULL,
  name         TEXT     NOT NULL,
  category     TEXT,
  status       TEXT     NOT NULL,   -- 'normal' | 'slow' | 'error' | 'placeholder'
  response_ms  INTEGER,
  http_status  INTEGER,
  message      TEXT,
  open_url     TEXT
);
CREATE INDEX IF NOT EXISTS idx_svc_service_recorded
  ON service_status(service_id, recorded_at DESC);

-- ④ 설정값 (새로고침 트리거 등)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
