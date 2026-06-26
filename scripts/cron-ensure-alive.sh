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
readonly DOWN_COUNT_FILE="${SUDO_CRON_DOWN_COUNT_FILE:-/tmp/sudo-ai-down-count}"
# Declare-then-assign (not `readonly X="$(...)"`) so a failing subshell can't be
# masked by the readonly builtin's own exit status (shellcheck SC2155).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
SUDO_HOME="${SUDO_AI_HOME:-$(cd "$SCRIPT_DIR/.." && pwd)}"
readonly SUDO_HOME

# ---- Pure decision helpers (leak-gate + down-cycle gate). Graceful degrade:
# if the lib is somehow absent the `command -v` guards below fall back to the
# original inline behavior, so a missing lib can never disable recovery. ----
readonly CRON_DECIDE_LIB="$SCRIPT_DIR/lib/cron-decide.sh"
if [ -f "$CRON_DECIDE_LIB" ]; then
  # shellcheck source=scripts/lib/cron-decide.sh
  source "$CRON_DECIDE_LIB"
fi

# ---- Singleton: only one copy of this script may run at a time ----
exec 200>"$LOCK"
if ! flock -n 200; then
  echo "[$(date -u +%FT%TZ)] LOCKED: another cron-ensure-alive is running -- exiting" >> "$LOG"
  exit 0
fi

# ---- Helper: count processes matching a pattern (pipefail-safe — 0 on no match) ----
count_pids() { local c; c=$(pgrep -cf "$1" 2>/dev/null) || c=0; echo "$c"; }

# ---- Helper: uptime (seconds) of the pm2-managed sudo-ai-v5 process; 999999 when not running (set-e safe) ----
# Queries pm2 directly rather than a pgrep pattern so it can't self-match this
# script's own argv or a transient subshell. A wrong age here could wrongly
# suppress a NEEDED restart, so it stays unambiguous: no managed pid → 999999.
daemon_age() {
  local pid age
  pid=$(pm2 pid sudo-ai-v5 2>/dev/null | head -1) || pid=""
  case "$pid" in ''|0) echo 999999; return 0;; esac
  age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ') || age=""
  echo "${age:-999999}"
}

# ---- Helper: is the prod app actually alive? echoes yes|no (set-e safe) ----
# Trusts the pm2-managed pid (same source as daemon_age) instead of a pgrep
# pattern: the prod daemon runs as `node --import tsx src/cli.ts` (argv
# `node .../src/cli.ts`), which the legacy `tsx src/cli.ts` pattern never
# matched. Used by the leak-gate so a healthy daemon's transient esbuild child
# is not mistaken for an orphan.
app_running() {
  local pid
  pid=$(pm2 pid sudo-ai-v5 2>/dev/null | head -1) || pid=""
  case "$pid" in ''|0) echo no; return 0;; esac
  if kill -0 "$pid" 2>/dev/null; then echo yes; else echo no; fi
}

# ---- Step 1: Detect leaked / duplicate Node processes ----
# We expect exactly ONE tsx process (prod). tsx legitimately spawns esbuild as
# a child during compile, so esbuild is only a leak when there is NO tsx
# running (orphaned from a previous tsx death).
LEAKED_TSX=$(count_pids "tsx src/cli\.ts")
LEAKED_ESBUILD=$(count_pids "esbuild")

# ---- Leak-gate (SUDO_CRON_LEAK_GATE=0 ⇒ legacy behavior) ----
# Two arms: (1) duplicate app instances (tsx>1) — UNCHANGED; (2) orphaned
# esbuild (esbuild>0 && tsx==0). Arm (2) used to fire whenever any esbuild
# existed, because tsx is permanently 0 (stale pgrep pattern) — so the healthy
# daemon's OWN transient esbuild child triggered a `pm2 delete+start` bounce
# every ~30min (self-inflicted restart churn). The gate adds the missing
# precondition: arm (2) is a real leak ONLY when the app is genuinely DOWN.
LEAK_TRIGGERED=no
LEAK_APP_RUNNING=n/a
if [ "$LEAKED_TSX" -gt 1 ]; then
  LEAK_TRIGGERED=yes
elif [ "$LEAKED_ESBUILD" -gt 0 ] && [ "$LEAKED_TSX" -eq 0 ]; then
  LEAK_APP_RUNNING=$(app_running)
  if [ "${SUDO_CRON_LEAK_GATE:-1}" != "0" ] && command -v is_orphan_esbuild_leak >/dev/null 2>&1; then
    if is_orphan_esbuild_leak "$LEAKED_TSX" "$LEAKED_ESBUILD" "$LEAK_APP_RUNNING"; then
      LEAK_TRIGGERED=yes
    else
      echo "[$(date -u +%FT%TZ)] esbuild present (esbuild=$LEAKED_ESBUILD tsx=$LEAKED_TSX) but app_running=$LEAK_APP_RUNNING -- not an orphan, leaving daemon alone (leak-gate)" >> "$LOG"
    fi
  else
    LEAK_TRIGGERED=yes   # legacy: gate disabled or lib unavailable
  fi
fi

if [ "$LEAK_TRIGGERED" = "yes" ]; then
  # Age guard: during a restart the old + new app processes can briefly coexist.
  # Skip the hard-reset when the app process is young (boot overlap, not an
  # orphaned leak) — nuking the legit replacement caused restart storms under load.
  # Compute the age ONCE so the skip decision and the log line agree (and so the
  # log records exactly the age the branch keyed off — restart-reason forensics).
  LEAK_DAEMON_AGE=$(daemon_age)
  if [ "$LEAK_DAEMON_AGE" -lt 300 ]; then
    echo "[$(date -u +%FT%TZ)] leak-suspect (tsx=$LEAKED_TSX esbuild=$LEAKED_ESBUILD app_running=$LEAK_APP_RUNNING daemon_age=${LEAK_DAEMON_AGE}s) but pm2 daemon <5min old -- boot overlap, skipping hard-reset" >> "$LOG"
  else
    echo "[$(date -u +%FT%TZ)] LEAK DETECTED: tsx=$LEAKED_TSX esbuild=$LEAKED_ESBUILD app_running=$LEAK_APP_RUNNING daemon_age=${LEAK_DAEMON_AGE}s -- hard-resetting" >> "$LOG"

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
  # App is up — clear the consecutive-down counter (down-gate reset point).
  if command -v write_counter >/dev/null 2>&1; then write_counter "$DOWN_COUNT_FILE" 0; fi
  exit 0
fi

# ---- Step 3: Port not bound. If PM2 says online, app is still booting -- wait. ----
if is_pm2_online; then
  # Booting, not down — clear the counter so a deploy transition can't accrue
  # toward the down threshold.
  if command -v write_counter >/dev/null 2>&1; then write_counter "$DOWN_COUNT_FILE" 0; fi
  echo "[$(date -u +%FT%TZ)] pm2 shows online, port not bound yet -- wait for next cron" >> "$LOG"
  exit 0
fi

# ---- Step 3b: Startup grace. If the app process was launched recently (by pm2
# or a prior cron) it may still be binding its port under load — wait one more
# cron cycle instead of racing a slow boot into a restart storm. ----
CLI_AGE=$(daemon_age)
if [ "$CLI_AGE" -lt 90 ]; then
  echo "[$(date -u +%FT%TZ)] port not bound but pm2 daemon ${CLI_AGE}s old (<90s) -- still booting, waiting" >> "$LOG"
  exit 0
fi

cd "$SUDO_HOME"
# ---- Down-gate (SUDO_CRON_DOWN_GATE=0 ⇒ legacy immediate restart) ----
# Require the daemon to be observed DOWN for >= threshold consecutive cron
# cycles before bouncing it. A pm2 restart/deploy transition is down for ~1
# cycle (port rebinds next minute → Step 2 resets the counter), so it rides
# through without a spurious restart; a GENUINE death persists >= threshold
# cycles and is still recovered ~1-2min later. pm2 autorestart remains the
# PRIMARY crash-recovery; this cron is the secondary net. daemon_age=999999 ⇒
# `pm2 pid` empty (pm2 restart/deploy transition signature).
if [ "${SUDO_CRON_DOWN_GATE:-1}" != "0" ] && command -v decide_down_restart >/dev/null 2>&1; then
  DOWN_THRESHOLD="${SUDO_CRON_DOWN_THRESHOLD:-2}"
  DOWN_COUNT=$(( $(read_counter "$DOWN_COUNT_FILE") + 1 ))
  write_counter "$DOWN_COUNT_FILE" "$DOWN_COUNT"
  if [ "$(decide_down_restart "$DOWN_COUNT" "$DOWN_THRESHOLD")" = "defer" ]; then
    echo "[$(date -u +%FT%TZ)] DOWN-PATH: down ${DOWN_COUNT} consecutive cycle(s) (<${DOWN_THRESHOLD}, daemon_age=${CLI_AGE}s) -- deferring restart one cycle (deploy-transition guard)" >> "$LOG"
    exit 0
  fi
  echo "[$(date -u +%FT%TZ)] DOWN-PATH: down ${DOWN_COUNT} consecutive cycle(s) (>=${DOWN_THRESHOLD}, daemon_age=${CLI_AGE}s) -- restarting via ecosystem config" >> "$LOG"
  write_counter "$DOWN_COUNT_FILE" 0
else
  # Legacy / kill-switch path: restart immediately on first down observation.
  echo "[$(date -u +%FT%TZ)] DOWN-PATH: sudo-ai-v5 port unbound + pm2 not online (daemon_age=${CLI_AGE}s) -- restarting via ecosystem config" >> "$LOG"
fi
pm2 delete sudo-ai-v5         >> "$LOG" 2>&1 || true
pm2 start ecosystem.config.cjs --only sudo-ai-v5 --update-env >> "$LOG" 2>&1
pm2 save --force              >> "$LOG" 2>&1 || true
echo "[$(date -u +%FT%TZ)] DOWN-PATH restart issued (pm2 start invoked)" >> "$LOG"
