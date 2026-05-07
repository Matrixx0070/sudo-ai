#!/usr/bin/env bash
# =============================================================================
# Bulletproof cron keepalive for sudo-ai-v5
# Prevents process leaks, restart storms, and duplicate instances.
# Run every minute from HOST cron (not inside bwrap sandboxes).
# =============================================================================

set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
export PM2_HOME=/root/.pm2
readonly LOG=/tmp/sudo-ai-v5-cron-keepalive.log
readonly LOCK=/tmp/sudo-ai-cron.lock
readonly SUDO_HOME=/root/sudo-ai-v4

# ---- Singleton: only one copy of this script may run at a time ----
exec 200>"$LOCK"
if ! flock -n 200; then
  echo "[$(date -u +%FT%TZ)] LOCKED: another cron-ensure-alive is running -- exiting" >> "$LOG"
  exit 0
fi

# ---- Helper: count processes matching a pattern ----
count_pids() { pgrep -f "$1" 2>/dev/null | wc -l; }

# ---- Step 1: Detect leaked / duplicate Node processes ----
LEAKED_TSX=$(count_pids "tsx src/cli\.ts")
LEAKED_ESBUILD=$(count_pids "esbuild")

# We expect exactly ONE tsx process (prod). Anything else is a leak.
if [ "$LEAKED_TSX" -gt 1 ] || [ "$LEAKED_ESBUILD" -gt 0 ]; then
  echo "[$(date -u +%FT%TZ)] LEAK DETECTED: tsx=$LEAKED_TSX esbuild=$LEAKED_ESBUILD -- hard-resetting" >> "$LOG"

  # Kill all leaked application processes (not pm2 daemon itself)
  pkill -9 -f "tsx src/cli\.ts" 2>/dev/null || true
  pkill -9 -f "esbuild"          2>/dev/null || true
  sleep 2

  # PM2 sometimes leaves "online" ghosts in its dump file even though the
  # underlying PIDs are dead. Delete the stale entries so pm2 start works.
  pm2 delete sudo-ai-v5-staging >> "$LOG" 2>&1 || true
  pm2 delete sudo-ai-v5         >> "$LOG" 2>&1 || true
  pm2 save --force              >> "$LOG" 2>&1 || true
  sleep 1

  # Start exactly one prod instance
  cd "$SUDO_HOME"
  pm2 start ecosystem.config.cjs --only sudo-ai-v5 --update-env >> "$LOG" 2>&1
  pm2 save --force >> "$LOG" 2>&1 || true
  echo "[$(date -u +%FT%TZ)] Restart complete. tsx=$(count_pids 'tsx src/cli\.ts')" >> "$LOG"
  exit 0
fi

# ---- Step 2: If port is open and PM2 shows online, everything is fine ----
if ss -lnt 2>/dev/null | grep -qE '(^|[[:space:]])(0\.0\.0\.0|127\.0\.0\.1):18900([[:space:]]|$)'; then
  # Double-check PM2 state is not lying
  STATUS=$(pm2 jlist 2>/dev/null | grep -o '"name":"sudo-ai-v5"[^}]*"status":"[^"]*"' | head -1 || true)
  if [[ "$STATUS" == *online* ]]; then
    exit 0
  fi
  # Port open but PM2 disagrees -- port might be held by a zombie. Treat as leak.
  echo "[$(date -u +%FT%TZ)] PORT 18900 open but PM2 status is NOT online -- zombie detected" >> "$LOG"
  fuser -k 18900/tcp 2>/dev/null || true
fi

# ---- Step 3: Normal "down" restart path ----
STATUS=$(pm2 jlist 2>/dev/null | grep -o '"name":"sudo-ai-v5"[^}]*"status":"[^"]*"' | head -1 || true)
if [[ "$STATUS" == *online* ]]; then
  echo "[$(date -u +%FT%TZ)] pm2 shows online, port not bound yet -- wait for next cron" >> "$LOG"
  exit 0
fi

cd "$SUDO_HOME"
echo "[$(date -u +%FT%TZ)] sudo-ai-v5 down, restarting via ecosystem config" >> "$LOG"
pm2 delete sudo-ai-v5         >> "$LOG" 2>&1 || true
pm2 start ecosystem.config.cjs --only sudo-ai-v5 --update-env >> "$LOG" 2>&1
pm2 save --force              >> "$LOG" 2>&1 || true
