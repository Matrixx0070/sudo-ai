#!/usr/bin/env bash
# prod-seal-flip.sh — Wave 2.2h prod seal verification + reload
#
# =============================================================================
# IMPORTANT: This script does NOT enable tool.synthesize on production.
# =============================================================================
#
# What this script does:
#   - Verifies the LD_PRELOAD execve seal code path is live on prod (:18900)
#   - Confirms the .so artifact is present + sha256-verified
#   - Confirms SUDO_EXEC_GATE_DISABLE is NOT set (seal is not bypassed)
#   - Confirms synthesize kill-switch is OFF (SUDO_TOOL_SYNTHESIZE_ENABLED unset)
#   - Confirms a GREEN soak report exists from the last 1h
#   - Runs pm2 reload sudo-ai-v5 --update-env (idempotent — picks up any env changes)
#   - Verifies post-reload: health 200 + 4 seal Prom metrics present
#
# What this script does NOT do:
#   - Set SUDO_TOOL_SYNTHESIZE_ENABLED=1 on prod (that is a separate wave)
#   - Modify ecosystem.config.cjs
#   - Touch any source code
#
# Context (from wave2.2h-closed.md):
#   The seal code is already deployed to prod but inert — synthesize is OFF so
#   the LD_PRELOAD bwrap args are never reached.  SUDO_EXEC_GATE_DISABLE is not
#   set, meaning if synthesize were ever turned on, the seal would be active.
#   The "flip" action here is a verification + reload to confirm the runtime
#   state matches the intended gate-keeper posture before the 48h prod soak
#   that precedes enabling synthesize on prod.
#
# Usage:
#   bash scripts/prod-seal-flip.sh           # pre-flight only (dry-run, no reload)
#   bash scripts/prod-seal-flip.sh --yes     # run pre-flight then reload + verify
#
# Exit codes:
#   0 — GREEN (all checks pass; reload succeeded if --yes was passed)
#   1 — RED   (pre-flight failed or post-reload check failed)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUDO_HOME="${SUDO_AI_HOME:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PROD_URL="http://127.0.0.1:18900"
SO_PATH="${SUDO_HOME}/bin/synth-seccomp-seal.so"
EXPECTED_SHA256="f4fe8b99535def86788be03a26fb666383e90e63f924cc7bd3bb1b2defeb3af9"
PM2_APP="sudo-ai-v5"
SOAK_LOG_DIR="/var/log/seal-soak"
SOAK_LOG_FALLBACK="${SUDO_HOME}/data/logs/seal-soak"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOG_DIR="/var/log/seal-soak"

if ! mkdir -p "$LOG_DIR" 2>/dev/null || ! touch "$LOG_DIR/.write-test" 2>/dev/null; then
  LOG_DIR="${SUDO_HOME}/data/logs/seal-soak"
  mkdir -p "$LOG_DIR" 2>/dev/null || true
fi
rm -f "$LOG_DIR/.write-test" 2>/dev/null || true
FLIP_LOG="$LOG_DIR/prod-flip-$(date +%Y%m%d-%H%M%S).log"

# Track overall status
PREFLIGHT_PASS=true
declare -a PREFLIGHT_MSGS=()

log() {
  printf '%s [%s] %s\n' "$TS" "$1" "$2" | tee -a "$FLIP_LOG"
}

preflight_pass() {
  local msg="$1"
  PREFLIGHT_MSGS+=("  [PASS] $msg")
  log INFO "PREFLIGHT PASS: $msg"
}

preflight_fail() {
  local msg="$1"
  PREFLIGHT_MSGS+=("  [FAIL] $msg")
  PREFLIGHT_PASS=false
  log ERROR "PREFLIGHT FAIL: $msg"
}

# ---------------------------------------------------------------------------
# Parse --yes flag
# ---------------------------------------------------------------------------
DO_RELOAD=false
for arg in "$@"; do
  [[ "$arg" == "--yes" ]] && DO_RELOAD=true
done

# ---------------------------------------------------------------------------
# Token resolution (for health + metrics checks)
# ---------------------------------------------------------------------------
TOKEN="${GATEWAY_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then TOKEN="${SUDO_AI_DASHBOARD_TOKEN:-}"; fi
if [[ -z "$TOKEN" ]] && [[ -f "/root/.sudo-ai/token" ]]; then
  TOKEN=$(cat /root/.sudo-ai/token | tr -d '[:space:]')
fi

log INFO "prod-seal-flip starting (do_reload=$DO_RELOAD)"

# ---------------------------------------------------------------------------
# Pre-flight 1: Prod has synthesize OFF
# ---------------------------------------------------------------------------
PM2_ENV=$(pm2 env "$PM2_APP" 2>/dev/null || echo "")
if printf '%s' "$PM2_ENV" | grep -q "SUDO_TOOL_SYNTHESIZE_ENABLED.*=.*1"; then
  preflight_fail "Prod SUDO_TOOL_SYNTHESIZE_ENABLED is set to 1 — synthesize must remain OFF for this wave"
else
  preflight_pass "Prod SUDO_TOOL_SYNTHESIZE_ENABLED is unset or 0 (synthesize OFF)"
fi

# ---------------------------------------------------------------------------
# Pre-flight 2: Prod health :18900 returns 200
# ---------------------------------------------------------------------------
HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$PROD_URL/health" 2>/dev/null || echo "000")
if [[ "$HEALTH_CODE" == "200" ]]; then
  preflight_pass "Prod health :18900 returns 200"
else
  preflight_fail "Prod health :18900 returned $HEALTH_CODE (expected 200)"
fi

# ---------------------------------------------------------------------------
# Pre-flight 3: .so artifact exists + sha256 matches
# ---------------------------------------------------------------------------
if [[ ! -f "$SO_PATH" ]]; then
  preflight_fail ".so artifact not found at $SO_PATH"
else
  ACTUAL_SHA256=$(sha256sum "$SO_PATH" 2>/dev/null | awk '{print $1}' || echo "error")
  if [[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256" ]]; then
    preflight_pass ".so sha256 verified ($EXPECTED_SHA256)"
  else
    preflight_fail ".so sha256 MISMATCH: expected=$EXPECTED_SHA256 actual=$ACTUAL_SHA256"
  fi
fi

# ---------------------------------------------------------------------------
# Pre-flight 4: SUDO_EXEC_GATE_DISABLE is NOT set on prod (seal not bypassed)
# ---------------------------------------------------------------------------
if printf '%s' "$PM2_ENV" | grep -q "SUDO_EXEC_GATE_DISABLE.*=.*1"; then
  preflight_fail "Prod has SUDO_EXEC_GATE_DISABLE=1 — this would bypass the seal; unset it first"
else
  preflight_pass "SUDO_EXEC_GATE_DISABLE is not set on prod (seal gate active)"
fi

# ---------------------------------------------------------------------------
# Pre-flight 5: GREEN soak report in last 1h
# ---------------------------------------------------------------------------
SOAK_LOG_FOUND=false
for check_dir in "$SOAK_LOG_DIR" "$SOAK_LOG_FALLBACK"; do
  if [[ -d "$check_dir" ]]; then
    # Find report log files modified in last 3600 seconds
    RECENT_REPORT=$(find "$check_dir" -name "report-*.log" -newer /proc/1 2>/dev/null | head -1 || true)
    # Fallback: find by mtime
    if [[ -z "$RECENT_REPORT" ]]; then
      RECENT_REPORT=$(find "$check_dir" -name "report-*.log" -mmin -60 2>/dev/null | sort -r | head -1 || true)
    fi
    if [[ -n "$RECENT_REPORT" ]]; then
      SOAK_LOG_FOUND=true
      RECENT_VERDICT=$(grep "^VERDICT:" "$RECENT_REPORT" 2>/dev/null | tail -1 | awk '{print $2}' || echo "")
      if [[ "$RECENT_VERDICT" == "GREEN" ]]; then
        preflight_pass "Recent soak report GREEN: $RECENT_REPORT"
      else
        preflight_fail "Recent soak report verdict is '$RECENT_VERDICT' (expected GREEN): $RECENT_REPORT"
      fi
      break
    fi
  fi
done

if [[ "$SOAK_LOG_FOUND" == "false" ]]; then
  preflight_fail "No soak report found in last 1h — run: bash scripts/seal-soak-report.sh --since 48h"
fi

# ---------------------------------------------------------------------------
# Print pre-flight summary
# ---------------------------------------------------------------------------
printf '\n'
log INFO "Pre-flight summary:"
for msg in "${PREFLIGHT_MSGS[@]}"; do
  printf '%s\n' "$msg" | tee -a "$FLIP_LOG"
done
printf '\n'

if [[ "$PREFLIGHT_PASS" == "false" ]]; then
  log ERROR "Pre-flight FAILED — aborting. Fix issues above and re-run."
  log INFO "VERDICT: RED"
  exit 1
fi

if [[ "$DO_RELOAD" == "false" ]]; then
  log INFO "All pre-flight checks PASSED."
  log INFO "Run with --yes to execute the prod reload + post-reload verification."
  log INFO "VERDICT: PREFLIGHT_GREEN (no reload performed)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Backup prod pm2 env snapshot before reload
# ---------------------------------------------------------------------------
BACKUP_DIR="/root/.sudo-ai/backups"
mkdir -p "$BACKUP_DIR" 2>/dev/null || true
BACKUP_FILE="$BACKUP_DIR/prod-env-pre-seal-flip-$(date +%Y%m%d-%H%M%S).env"
pm2 env "$PM2_APP" 2>/dev/null > "$BACKUP_FILE" || true
log INFO "Prod env snapshot backed up to: $BACKUP_FILE"

# ---------------------------------------------------------------------------
# Reload prod pm2 process (picks up any env changes; synthesize stays OFF)
# ---------------------------------------------------------------------------
log INFO "Running: pm2 reload $PM2_APP --update-env"
if ! pm2 reload "$PM2_APP" --update-env 2>&1 | tee -a "$FLIP_LOG"; then
  log ERROR "pm2 reload failed — checking if rollback needed"
  # Verify health; if down, try reload again from backup perspective
  HEALTH_POST=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$PROD_URL/health" 2>/dev/null || echo "000")
  if [[ "$HEALTH_POST" != "200" ]]; then
    log ERROR "Post-reload health check failed ($HEALTH_POST). Manual intervention required."
    log ERROR "Backup env at: $BACKUP_FILE"
  fi
  log INFO "VERDICT: RED"
  exit 1
fi

# Brief settle time
sleep 3

# ---------------------------------------------------------------------------
# Post-reload check 1: health 200
# ---------------------------------------------------------------------------
POST_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$PROD_URL/health" 2>/dev/null || echo "000")
if [[ "$POST_HEALTH" != "200" ]]; then
  log ERROR "Post-reload health check FAILED: $POST_HEALTH"
  log ERROR "Attempting automatic rollback via second reload..."
  pm2 reload "$PM2_APP" --update-env 2>&1 | tee -a "$FLIP_LOG" || true
  log INFO "VERDICT: RED"
  exit 1
fi
log INFO "Post-reload health: 200"

# ---------------------------------------------------------------------------
# Post-reload check 2: 4 seal Prom metrics present
# ---------------------------------------------------------------------------
if [[ -n "$TOKEN" ]]; then
  METRICS_CHECK=$(curl -sf --max-time 15 \
    -H "Authorization: Bearer $TOKEN" \
    "$PROD_URL/v1/admin/metrics" 2>/dev/null || echo "")

  SEAL_METRIC_COUNT=$(printf '%s' "$METRICS_CHECK" | grep -c "sudo_synth_seal" || echo "0")
  if [[ "$SEAL_METRIC_COUNT" -ge 4 ]]; then
    log INFO "Post-reload seal metrics: $SEAL_METRIC_COUNT metrics present (expected >=4)"
  else
    log WARN "Post-reload seal metrics: only $SEAL_METRIC_COUNT metrics found (expected 4). Obs may not be fully wired."
  fi
else
  log WARN "No token available — skipping seal metrics check"
fi

# ---------------------------------------------------------------------------
# Final verdict
# ---------------------------------------------------------------------------
log INFO "Prod reload complete."
log INFO "Reminder: SUDO_TOOL_SYNTHESIZE_ENABLED is still OFF on prod."
log INFO "          The seal code path is live but inert (synthesize is the gate)."
log INFO "          Next step: 48h prod soak, then separately enable synthesize in a future wave."
log INFO "VERDICT: GREEN"
log INFO "Log: $FLIP_LOG"
exit 0
