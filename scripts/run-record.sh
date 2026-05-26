#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# NAS 저장소 사용량 자동 기록 — cron / 스케줄러용 래퍼 스크립트
#
# crontab 등록 예시 (1시간마다):
#   0 * * * * /절대경로/richschool-status-dashboard/scripts/run-record.sh >> /절대경로/logs/record-history.log 2>&1
#
# 로그 파일을 남기지 않으려면:
#   0 * * * * /절대경로/richschool-status-dashboard/scripts/run-record.sh > /dev/null 2>&1
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# 이 스크립트가 위치한 디렉터리를 기준으로 프로젝트 루트로 이동
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

exec npm run record-history
