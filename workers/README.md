# Cloudflare Workers + Pages — 설정 가이드

> **전체 마이그레이션 완료 구조**:
> UI(Pages) + API(Workers) + 데이터(D1) + 수집기(내부망 Mac Mini/NAS)

---

## 아키텍처 요약

```
[팀원 브라우저]
  │ HTTPS (Cloudflare Access 인증)
  ▼
[Cloudflare Pages]  — 정적 UI (빌드 결과물: out/)
  │ fetch(NEXT_PUBLIC_CF_WORKERS_URL + '/api/...')
  ▼
[Cloudflare Workers]  — API 처리
  │ D1 SQL
  ▼
[Cloudflare D1]  — 데이터 저장

[내부 수집기 (Mac Mini)]
  │ NAS DSM API (내부망)   │ 서비스 헬스체크 (내부망)
  ▼                        ▼
  POST /api/ingest/*  → Workers → D1
  (1시간마다 cron으로 실행)
```

---

## Workers 엔드포인트 목록

| 메서드 | 경로 | 인증 | 설명 |
|--------|------|------|------|
| `POST` | `/api/ingest/storage`    | `X-API-Key` | 저장소 스냅샷 기록 |
| `POST` | `/api/ingest/nas-status` | `X-API-Key` | NAS 전체 상태 기록 |
| `POST` | `/api/ingest/services`   | `X-API-Key` | 서비스 헬스 상태 기록 |
| `GET`  | `/api/storage-history`   | 없음        | 저장소 스냅샷 조회 |
| `GET`  | `/api/nas-status`        | 없음        | 최신 NAS 상태 조회 |
| `GET`  | `/api/services`          | 없음        | 최신 서비스 상태 조회 |

---

## Part 1 — Workers 초기 설정 (최초 1회)

### 1. 의존성 설치

```bash
cd workers
npm install
```

### 2. Cloudflare 로그인

```bash
npx wrangler login
```

### 3. D1 데이터베이스 생성

```bash
npm run db:create
```

출력된 `uuid`를 `wrangler.toml`의 `database_id`에 붙여넣습니다.

### 4. D1 테이블 생성 (신규 테이블 추가 시에도 재실행)

```bash
npm run db:init   # 원격 D1
```

> `IF NOT EXISTS` 사용으로 기존 데이터 영향 없음. 테이블 추가 후 언제든 재실행 가능.

### 5. API Key 시크릿 등록

```bash
npx wrangler secret put CF_INGEST_API_KEY
# 프롬프트에 임의의 긴 문자열 입력 (예: openssl rand -base64 32)
```

### 6. Workers 배포

```bash
npm run deploy
# 출력 예: https://richschool-dashboard-api.계정명.workers.dev
```

---

## Part 2 — 수집기 설정 (.env.local)

프로젝트 루트 `.env.local`에 아래 항목을 추가합니다:

```env
# Cloudflare Workers 연동
CF_WORKERS_URL=https://richschool-dashboard-api.계정명.workers.dev
CF_INGEST_API_KEY=5단계에서_입력한_키
```

**테스트:**

```bash
# 프로젝트 루트에서
npm run push-to-cf:dry   # 조회만, 전송 없음
npm run push-to-cf       # 실제 전송 (저장소 + NAS 상태 + 서비스 헬스)
```

**cron 등록 (1시간마다):**

```bash
crontab -e
# 아래 줄 추가 (절대 경로로 수정):
0 * * * * /절대경로/scripts/run-push.sh >> /tmp/push-cf.log 2>&1
```

---

## Part 3 — Cloudflare Pages 배포

### Pages 프로젝트 생성

1. [Cloudflare 대시보드](https://dash.cloudflare.com) → Pages → 프로젝트 만들기
2. Git 연결 또는 Direct Upload 선택
3. 빌드 설정:
   - **Framework preset**: None
   - **Build command**: `npm run build`
   - **Build output directory**: `out`

### Pages 환경변수 설정

Pages 프로젝트 → Settings → Environment variables → Production:

| 변수명 | 값 |
|--------|-----|
| `NEXT_EXPORT` | `true` |
| `NEXT_PUBLIC_CF_WORKERS_URL` | `https://richschool-dashboard-api.계정명.workers.dev` |

> `NEXT_PUBLIC_CF_WORKERS_URL`은 브라우저에서 Workers API를 직접 호출하는 데 사용됩니다.

### 로컬에서 Pages 빌드 미리 확인

```bash
# 프로젝트 루트에서
NEXT_EXPORT=true NEXT_PUBLIC_CF_WORKERS_URL=https://...workers.dev npm run build
# → out/ 디렉터리에 정적 파일 생성 확인
```

---

## Part 4 — Cloudflare Access 설정 (팀 접근 제어, 선택)

1. Cloudflare Zero Trust → Access → Applications → Add
2. Application type: Self-hosted
3. Domain: Pages 도메인 (예: `richschool-dashboard.pages.dev`)
4. Policy: 팀원 이메일 허용 (또는 Google Workspace 그룹)

> GET API 엔드포인트(`/api/*`)는 Access에서 Bypass 처리하거나,
> Workers에도 Cloudflare Access 토큰 검증 로직을 추가할 수 있습니다.

---

## D1 데이터 직접 확인

```bash
cd workers

# 최신 NAS 상태 확인
npx wrangler d1 execute richschool-storage-history \
  --remote --command "SELECT recorded_at, total_bytes, used_bytes FROM nas_status ORDER BY recorded_at DESC LIMIT 3;"

# 최신 서비스 상태 확인
npx wrangler d1 execute richschool-storage-history \
  --remote --command "SELECT recorded_at, service_id, status, response_ms FROM service_status ORDER BY recorded_at DESC LIMIT 10;"

# 저장소 스냅샷 확인
npx wrangler d1 execute richschool-storage-history \
  --remote --command "SELECT * FROM storage_snapshots ORDER BY recorded_at DESC LIMIT 5;"
```

---

## 배포 전 체크리스트

- [ ] `wrangler.toml`의 `database_id`가 실제 D1 ID로 채워져 있음
- [ ] `npm run db:init` 완료 (3개 테이블 모두 생성됨)
- [ ] `CF_INGEST_API_KEY` secret 등록 완료
- [ ] `npm run deploy` 완료, Workers URL 확인
- [ ] `.env.local`에 `CF_WORKERS_URL`, `CF_INGEST_API_KEY` 입력
- [ ] `npm run push-to-cf:dry` 성공 (NAS 연결 확인)
- [ ] `npm run push-to-cf` 성공 (D1 기록 확인)
- [ ] D1에서 데이터 3개 테이블 모두 기록 확인
- [ ] `cron` 또는 Synology 작업 스케줄러 등록

## 배포 후 체크리스트

- [ ] Cloudflare Pages 빌드 성공 (`out/` 생성)
- [ ] Pages 도메인에서 대시보드 접속 확인
- [ ] 서비스 상태 카드 표시 확인
- [ ] NAS 저장소 섹션 표시 확인
- [ ] `/storage-history` 페이지에서 차트 표시 확인
- [ ] "데이터 기준" 시각이 마지막 수집 시각을 반영하는지 확인
- [ ] cron 실행 후 데이터 갱신 확인
