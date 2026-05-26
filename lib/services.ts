import type { ServiceConfig } from './types';

// 응답이 이 시간(ms)을 넘으면 '느림'으로 표시합니다.
export const DEFAULT_SLOW_THRESHOLD_MS = 1500;

// 모니터링할 서비스 목록.
// 새 서비스를 추가하려면 이 배열에 항목 하나만 추가하면 됩니다.
//
// healthCheckUrl : 서버사이드에서 가용성을 점검할 때 호출하는 URL
// openUrl        : 카드 클릭 시 새 탭에서 열 URL (없으면 카드는 클릭 불가)
//
// 두 URL을 분리한 이유: 점검은 외부(DDNS) 경로로 해야 의미가 있는 항목이라도,
// 사용자가 실제로 접근할 때는 더 빠른 내부망 경로로 보내고 싶을 때가 있기 때문입니다.
export const services: ServiceConfig[] = [
  {
    id: 'synology-dsm-internal',
    name: 'Synology DSM (사내망)',
    category: 'NAS',
    healthCheckUrl: 'https://192.168.1.136:5001',
    openUrl: 'https://192.168.1.136:5001',
    timeoutMs: 5000,
    successStatusCodes: [200, 301, 302, 307, 308, 401, 403],
    allowSelfSignedCert: true,
  },
  {
    id: 'synology-drive',
    name: 'Synology Drive',
    category: '협업 도구',
    // 점검은 DDNS 경로(외부 접근 가용성 확인), 클릭은 사내망 경로(빠른 접속).
    healthCheckUrl: 'https://richschool.synology.me:5001/drive',
    openUrl: 'https://192.168.1.136:5001/drive',
    timeoutMs: 7000,
    successStatusCodes: [200, 301, 302, 307, 308, 401, 403, 404],
    allowSelfSignedCert: true,
  },
  {
    id: 'ddns-domain',
    name: 'DDNS 도메인 (richschool.synology.me)',
    category: '네트워크',
    healthCheckUrl: 'https://richschool.synology.me:5001',
    openUrl: 'https://richschool.synology.me:5001',
    timeoutMs: 7000,
    successStatusCodes: [200, 301, 302, 307, 308, 401, 403, 404],
    allowSelfSignedCert: true,
  },
  {
    id: 'placeholder',
    name: '추가 예정 서비스',
    category: '기타',
    timeoutMs: 0,
    successStatusCodes: [],
    isPlaceholder: true,
  },
];
