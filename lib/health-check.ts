import { Agent, fetch as undiciFetch } from 'undici';
import type { ServiceConfig, ServiceStatus } from './types';
import { DEFAULT_SLOW_THRESHOLD_MS } from './services';
import { recordFailure, getLastFailure } from './failure-tracker';

// 사내 NAS 등 자체 서명 인증서를 쓰는 서비스를 위해 인증서 검증을 끈 별도 디스패처.
// 외부 인증서를 검증해야 하는 서비스는 이 디스패처를 사용하지 않습니다.
const insecureAgent = new Agent({
  connect: { rejectUnauthorized: false },
});

function extractCauseMessage(err: unknown): string {
  const e = err as Error & { cause?: { message?: string; code?: string } };
  return e.cause?.message ?? e.message ?? '알 수 없는 오류';
}

async function checkServiceCore(service: ServiceConfig): Promise<ServiceStatus> {
  const lastCheckedAt = new Date().toISOString();
  // 모든 응답에 공통으로 들어가는 식별 정보 + 클릭 이동 URL.
  const base = {
    id: service.id,
    name: service.name,
    category: service.category,
    openUrl: service.openUrl,
    lastCheckedAt,
  };

  if (service.isPlaceholder) {
    return {
      ...base,
      status: 'placeholder',
      responseTimeMs: null,
      message: '추후 추가될 서비스를 위한 자리입니다.',
    };
  }

  if (!service.healthCheckUrl) {
    return {
      ...base,
      status: 'error',
      responseTimeMs: null,
      message: '점검 URL이 설정되어 있지 않습니다.',
    };
  }

  const slowThreshold = service.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), service.timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await undiciFetch(service.healthCheckUrl, {
      method: 'GET',
      signal: controller.signal,
      // 로그인 페이지 등으로의 리다이렉트도 '서버가 살아있다'는 증거로 보고 그대로 받습니다.
      redirect: 'manual',
      dispatcher: service.allowSelfSignedCert ? insecureAgent : undefined,
      headers: {
        'User-Agent': 'RichschoolStatusDashboard/1.0',
      },
    });
    const elapsed = Math.round(performance.now() - startedAt);
    const httpStatus = response.status;

    const statusMatches = service.successStatusCodes.length === 0
      ? true
      : service.successStatusCodes.includes(httpStatus);

    let textMatches = true;
    if (service.expectedTextContains) {
      const body = await response.text();
      textMatches = body.includes(service.expectedTextContains);
    }

    if (!statusMatches) {
      return {
        ...base,
        status: 'error',
        responseTimeMs: elapsed,
        httpStatus,
        message: `예기치 않은 응답이 왔습니다. (HTTP ${httpStatus}) 서버 상태를 확인해 주세요.`,
      };
    }

    if (!textMatches) {
      return {
        ...base,
        status: 'error',
        responseTimeMs: elapsed,
        httpStatus,
        message: '응답 내용이 예상과 달라요. 서비스 점검이 필요할 수 있습니다.',
      };
    }

    const isSlow = elapsed > slowThreshold;
    return {
      ...base,
      status: isSlow ? 'slow' : 'normal',
      responseTimeMs: elapsed,
      httpStatus,
      message: isSlow
        ? '응답이 평소보다 느립니다. 잠시 후 다시 확인해 주세요.'
        : '정상적으로 응답하고 있습니다.',
    };
  } catch (error) {
    const elapsed = Math.round(performance.now() - startedAt);
    const err = error as Error;
    // AbortController.abort() 호출 시 발생하는 에러는 타임아웃으로 간주합니다.
    const isAbort = err.name === 'AbortError' || /aborted/i.test(err.message);
    return {
      ...base,
      status: 'error',
      responseTimeMs: elapsed,
      message: isAbort
        ? `응답이 없습니다. 제한 시간 ${service.timeoutMs}ms를 초과했습니다.`
        : `서버에 접근할 수 없습니다. (${extractCauseMessage(error)})`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * checkServiceCore를 실행한 뒤:
 * - 오류 상태면 마지막 실패 시각을 기록합니다.
 * - 반환 값에 lastFailedAt을 첨부합니다 (placeholder 제외).
 */
export async function checkService(service: ServiceConfig): Promise<ServiceStatus> {
  const result = await checkServiceCore(service);
  if (result.status === 'placeholder') return result;
  if (result.status === 'error') recordFailure(service.id);
  return { ...result, lastFailedAt: getLastFailure(service.id) };
}

export async function checkAllServices(list: ServiceConfig[]): Promise<ServiceStatus[]> {
  // 모든 서비스를 동시에 점검해 전체 응답 시간을 줄입니다.
  return Promise.all(list.map(checkService));
}
