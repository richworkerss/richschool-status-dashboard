/**
 * 서비스별 마지막 실패 시각을 서버 메모리에서 관리합니다.
 *
 * - Next.js Node.js 런타임에서 모듈 수준 변수는 프로세스 수명 동안 유지됩니다.
 * - 서버 재시작 시 초기화됩니다. (경량 운영용 — 영속 저장소 불필요)
 */
const failureMap = new Map<string, string>(); // serviceId → ISO timestamp

/** 서비스가 오류 상태로 판정됐을 때 현재 시각을 기록합니다. */
export function recordFailure(serviceId: string): void {
  failureMap.set(serviceId, new Date().toISOString());
}

/** 기록된 마지막 실패 시각을 반환합니다. 기록이 없으면 null. */
export function getLastFailure(serviceId: string): string | null {
  return failureMap.get(serviceId) ?? null;
}
