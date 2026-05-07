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

# ---- Helper: count processes matching a pattern (pipefail-safe — 0 on no match) ----
count_pids() { local c; c=$(pgrep -cf "$1" 2>/dev/null) || c=0; echo "$c"; }

# ---- Step 1: Detect leaked / duplicate Node processes ----
# We expect exactly ONE tsx process (prod). tsx legitimately spawns esbuild as
# a child during compile, so esbuild is only a leak when there is NO tsx
# running (orphaned from a previous tsx death).
LEAKED_TSX=$(count_pids "tsx src/cli\.ts")
LEAKED_ESBUILD=$(count_pids "esbuild")

if [ "$LEAKED_TSX" -gt 1 ] || { [ "$LEAKED_ESBUILD" -gt 0 ] && [ "$LEAKED_TSX" -eq 0 ]; }; then
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

# ---- Helper: is sudo-ai-v5 online in pm2? (robust, JSON-aware) ----
# Avoid fragile grep patterns; use Python to parse JSON properly. Returns 0 if online.
is_pm2_online() {
  pm2 jlist 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)
for p in d:
    if p.get('name') == 'sudo-ai-v5' and p.get('pm2_env', {}).get('status') == 'online':
        sys.exit(0)
sys.exit(1)
" 2>/dev/null
}

# ---- Step 2: If port is open, app is running. Trust the port. ----
if ss -lnt 2>/dev/null | grep -qE '(^|[[:space:]])(0\.0\.0\.0|127\.0\.0\.1):18900([[:space:]]|$)'; then
  exit 0
fi

# ---- Step 3: Port not bound. If PM2 says online, app is still booting -- wait. ----
if is_pm2_online; then
  echo "[$(date -u +%FT%TZ)] pm2 shows online, port not bound yet -- wait for next cron" >> "$LOG"
  exit 0
fi

cd "$SUDO_HOME"
echo "[$(date -u +%FT%TZ)] sudo-ai-v5 down, restarting via ecosystem config" >> "$LOG"
pm2 delete sudo-ai-v5         >> "$LOG" 2>&1 || true
pm2 start ecosystem.config.cjs --only sudo-ai-v5 --update-env >> "$LOG" 2>&1
pm2 save --force              >> "$LOG" 2>&1 || true
