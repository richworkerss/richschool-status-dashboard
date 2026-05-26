# Richschool 시스템 상태 대시보드

리치스쿨 사내 주요 시스템(Synology DSM, Drive, DDNS 등)의 가용성을
비기술 직원도 한 눈에 확인할 수 있도록 만든 내부용 상태 대시보드입니다.

## 주요 기능

- 서비스별 상태 카드 (`정상` / `느림` / `오류` / `대기`)
- 응답 시간, HTTP 상태 코드, 마지막 확인 시각 표시
- 30초 자동 새로고침 + 수동 새로고침 버튼
- 상태 점검은 모두 서버사이드(API Route)에서 수행 — 브라우저는 외부 서비스에 직접 접근하지 않음
- 서비스 설정은 `lib/services.ts` 한 곳에서만 관리

## 기술 스택

- Next.js 14 (App Router)
- TypeScript
- 서버사이드 fetch (`undici`) + AbortController 기반 타임아웃

## 모니터링 대상 (초기 버전)

| ID                       | 이름                              | URL                                          |
| ------------------------ | --------------------------------- | -------------------------------------------- |
| `synology-dsm-internal`  | Synology DSM (사내망)             | `https://192.168.1.136:5001`                 |
| `synology-drive`         | Synology Drive                    | `https://richschool.synology.me:5001/drive`  |
| `ddns-domain`            | DDNS 도메인 (richschool.synology.me) | `https://richschool.synology.me:5001`        |
| `placeholder`            | 추가 예정 서비스                  | —                                            |

## 로컬 실행

```bash
# 1. 의존성 설치
npm install

# 2. 개발 서버 실행
npm run dev
```

브라우저에서 `http://localhost:3000` 에 접속하면 대시보드를 확인할 수 있습니다.
원시 API 응답을 보고 싶다면 `http://localhost:3000/api/health` 로 접속하세요.

> 사내망(192.168.1.136) 점검 항목은 회사 네트워크에 연결되어 있을 때만 정상으로 표시됩니다.
> 외부에서 실행하면 해당 카드는 `오류`로 표시되는 것이 정상입니다.

## 빌드 / 운영

```bash
npm run build
npm run start
```

## 새 서비스 추가하기

`lib/services.ts`의 `services` 배열에 항목 하나를 추가하면 됩니다. 예시:

```ts
{
  id: 'printer-office',
  name: '사무실 프린터',
  category: '오피스',
  healthCheckUrl: 'http://192.168.1.50',
  openUrl: 'http://192.168.1.50',
  timeoutMs: 5000,
  successStatusCodes: [200, 401, 403],
  expectedTextContains: 'Printer',
}
```

### 지원 필드

| 필드                   | 필수 | 설명                                                                  |
| ---------------------- | ---- | --------------------------------------------------------------------- |
| `id`                   | O    | 서비스 고유 식별자                                                    |
| `name`                 | O    | 대시보드에 노출될 한국어 이름                                         |
| `healthCheckUrl`       | △    | 서버 사이드 상태 점검에 사용할 URL (`isPlaceholder: true`이면 생략)   |
| `openUrl`              | X    | 카드 클릭 시 새 탭에서 열 URL. 비워두면 카드는 클릭 불가             |
| `timeoutMs`            | O    | 응답 타임아웃 (밀리초)                                                |
| `successStatusCodes`   | O    | 정상으로 인정할 HTTP 상태 코드 목록                                   |
| `expectedTextContains` | X    | 응답 본문에 반드시 포함되어야 하는 문자열                            |
| `category`             | X    | 카드 상단에 표시될 분류 라벨                                          |
| `allowSelfSignedCert`  | X    | 자체 서명 인증서 사용 시 `true`                                       |
| `slowThresholdMs`      | X    | '느림'으로 표시할 응답 시간 기준 (기본 1500ms)                        |
| `isPlaceholder`        | X    | 점검 없이 자리만 표시할 때 `true`                                     |

`healthCheckUrl`과 `openUrl`을 분리해 두면, 점검은 외부(DDNS) 경로로 가용성을 확인하고
클릭은 더 빠른 사내망 경로로 보내는 식으로 분리해 운영할 수 있습니다.

## 디렉터리 구조

```
.
├── app/
│   ├── api/health/route.ts   # 서버사이드 헬스체크 API
│   ├── globals.css           # 전역 스타일
│   ├── layout.tsx            # 루트 레이아웃
│   └── page.tsx              # 대시보드 페이지 (클라이언트 컴포넌트)
├── lib/
│   ├── health-check.ts       # 점검 로직 (타임아웃/인증서/판정 규칙)
│   ├── services.ts           # 모니터링 대상 목록
│   └── types.ts              # 공유 타입 정의
├── next.config.js
├── package.json
└── tsconfig.json
```

## 보안 / 운영 메모

- 외부 서비스 호출은 항상 서버에서 일어나므로, 인증 정보를 추가하더라도 프론트엔드에는 노출되지 않습니다.
- 사내 NAS는 자체 서명 인증서를 사용해 `allowSelfSignedCert: true` 옵션으로 호출합니다.
- 현재 버전은 인증/권한과 상태 이력 저장이 없습니다. 사내망 전용으로만 사용하세요.

## 향후 확장 아이디어

- 프린터, 라이브 스트리밍 서버, NAS 리소스 사용량(CPU/메모리/디스크) 모니터링
- 상태 변경 시 Slack/Teams Webhook 알림
- 상태 이력 저장 및 다운타임 통계
- 카테고리별 필터링 / 검색
