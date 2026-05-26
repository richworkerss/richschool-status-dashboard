#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# NAS → Cloudflare D1 자동 푸시 — cron / 스케줄러용 래퍼 스크립트
#
# crontab 등록 예시 (1시간마다):
#   0 * * * * /절대경로/richschool-status-dashboard/scripts/run-push.sh >> /절대경로/logs/push-cf.log 2>&1
#
# 로그 파일 없이 실행하려면:
#   0 * * * * /절대경로/richschool-status-dashboard/scripts/run-push.sh > /dev/null 2>&1
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

exec npm run push-to-cf
