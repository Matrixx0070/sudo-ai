#!/usr/bin/env bash
# Cron-driven keepalive for sudo-ai-v5. Runs every minute from HOST cron
# (not bwrap'd Claude Code bash sandboxes), so pm2 daemon persists across
# my Claude sessions. Installed 2026-04-18 by Lead for Wave 2 deploy.

set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
export PM2_HOME=/root/.pm2
LOG=/tmp/sudo-ai-v5-cron-keepalive.log

# Already alive? Nothing to do.
if ss -lnt 2>/dev/null | grep -qE '(^|[[:space:]])(0\.0\.0\.0|127\.0\.0\.1):18900([[:space:]]|$)'; then
  exit 0
fi

# Check pm2 list. If sudo-ai-v5 online, socket just hasn't rebound yet — wait.
STATUS=$(pm2 jlist 2>/dev/null | grep -o '"name":"sudo-ai-v5"[^}]*"status":"[^"]*"' | head -1 || true)
if [[ "$STATUS" == *online* ]]; then
  echo "[$(date -u +%FT%TZ)] pm2 shows online, skipping restart" >> "$LOG"
  exit 0
fi

cd /root/sudo-ai-v4
echo "[$(date -u +%FT%TZ)] sudo-ai-v5 down, restarting via ecosystem config" >> "$LOG"
pm2 delete sudo-ai-v5 >> "$LOG" 2>&1 || true
pm2 start ecosystem.config.cjs --only sudo-ai-v5 --update-env >> "$LOG" 2>&1
pm2 save --force >> "$LOG" 2>&1 || true
