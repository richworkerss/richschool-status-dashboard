export type ServiceStatusLevel = 'normal' | 'slow' | 'error' | 'placeholder';

export type ServiceConfig = {
  id: string;
  name: string;
  category?: string;
  /** 서버에서 상태를 확인할 때 호출하는 URL. */
  healthCheckUrl?: string;
  /** 카드 클릭 시 새 탭에서 열 URL. 비워두면 카드는 클릭 불가. */
  openUrl?: string;
  timeoutMs: number;
  successStatusCodes: number[];
  expectedTextContains?: string;
  allowSelfSignedCert?: boolean;
  slowThresholdMs?: number;
  isPlaceholder?: boolean;
};

export type ServiceStatus = {
  id: string;
  name: string;
  category?: string;
  status: ServiceStatusLevel;
  responseTimeMs: number | null;
  lastCheckedAt: string;
  message?: string;
  httpStatus?: number;
  /** 카드 클릭 시 열 URL (있을 때만 클릭 가능 카드로 렌더링). */
  openUrl?: string;
  /** 서버 메모리에 기록된 마지막 실패 시각. 실패 이력 없으면 null. */
  lastFailedAt?: string | null;
};

export type HealthResponse = {
  checkedAt: string;
  services: ServiceStatus[];
};

/* ─────────────────────────────────────────────────────────────────────────────
   NAS 저장소 정보
   ───────────────────────────────────────────────────────────────────────────── */
export type NasHealthLevel = 'normal' | 'warning' | 'error' | 'unknown';

export type NasVolume = {
  id: string;
  name: string;
  status: NasHealthLevel;
  raidType: string;    // "SHR", "RAID 1", "Basic" …
  filesystem: string;  // "btrfs", "ext4" …
  /** null = API 응답에서 해당 필드를 읽지 못함 */
  totalBytes: number | null;
  usedBytes:  number | null;
};

export type NasDisk = {
  id: string;
  name: string;
  model: string;
  /** null = API 응답에서 해당 필드를 읽지 못함 */
  capacityBytes: number | null;
  health: NasHealthLevel;
  temperatureC: number | null;
};

export type NasStorageInfo = {
  fetchedAt: string;
  /** null = 모든 볼륨에서 용량 정보를 가져오지 못함 */
  totalBytes: number | null;
  usedBytes:  number | null;
  volumes: NasVolume[];
  disks: NasDisk[];
  /** DSM 시스템 업타임(초). API 응답에서 읽지 못하면 null. */
  uptimeSeconds: number | null;
};

/** 히스토리 페이지용 — 특정 시점의 NAS 용량 스냅샷 */
export type StorageSnapshot = {
  recordedAt: string;   // ISO 8601 타임스탬프
  totalBytes: number;   // 전체 용량 (bytes)
  usedBytes: number;    // 사용 중 용량 (bytes)
};

/** 히스토리 API 응답 */
export type StorageHistoryResponse =
  | { ok: true; snapshots: StorageSnapshot[] }
  | { ok: false; error: string };

/** API 응답 — 차별화된 유니언 타입으로 성공/실패/미설정을 구분합니다. */
export type NasStorageResponse =
  | { ok: true; data: NasStorageInfo }
  | { ok: false; error: string; configured: boolean };
