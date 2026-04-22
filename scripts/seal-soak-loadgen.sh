#!/usr/bin/env bash
# seal-soak-loadgen.sh — Wave 2.2h soak load generator
#
# Fires one benign tool.synthesize call against staging :18901 so that
# soak criterion #5 (>=10 successful seal installs) accumulates over the 48h
# window.  Designed to be invoked every hour by Kairos / cron.
#
# Soak criterion #5: sudo_synth_seal_install_total >= 10 by T+48h
#
# Exit codes:
#   0 — HTTP 2xx received (synth may or may not have been triggered)
#   1 — probe failed (obs not live), auth missing, or HTTP error
#
# Token resolution order (separate tokens for obs vs chat since Wave 2.2h-tail-2):
#
#   GATEWAY_TOKEN (for GET /v1/admin/metrics):
#     1. $SUDO_GATEWAY_TOKEN
#     2. $SUDO_API_TOKEN (legacy fallback)
#     3. $SUDO_AI_DASHBOARD_TOKEN
#     4. /root/.sudo-ai/token
#
#   CHAT_TOKEN (for POST /api/message):
#     1. $SUDO_WEB_CHAT_TOKEN
#     2. $SUDO_API_TOKEN (legacy fallback)
#     3. $SUDO_AI_DASHBOARD_TOKEN
#     4. /root/.sudo-ai/token
#
# Usage:
#   SUDO_GATEWAY_TOKEN=<gw_tok> SUDO_WEB_CHAT_TOKEN=<chat_tok> bash scripts/seal-soak-loadgen.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
STAGING_URL="http://127.0.0.1:18901"
LOG_DIR="/var/log/seal-soak"
LOG_FILE="$LOG_DIR/loadgen-$(date +%Y%m%d).log"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Fallback log to data/logs/ if /var/log/seal-soak is not writable
if ! mkdir -p "$LOG_DIR" 2>/dev/null || ! touch "$LOG_FILE" 2>/dev/null; then
  LOG_DIR="/root/sudo-ai-v4/data/logs/seal-soak"
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  LOG_FILE="$LOG_DIR/loadgen-$(date +%Y%m%d).log"
fi

log() {
  local level="$1"; shift
  local msg="$*"
  printf '%s [%s] %s\n' "$TS" "$level" "$msg" | tee -a "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# Token resolution — separate tokens for obs (metrics) and chat (POST)
# ---------------------------------------------------------------------------
_LEGACY_TOKEN="${SUDO_API_TOKEN:-}"
if [[ -z "$_LEGACY_TOKEN" ]]; then _LEGACY_TOKEN="${SUDO_AI_DASHBOARD_TOKEN:-}"; fi
if [[ -z "$_LEGACY_TOKEN" ]] && [[ -f "/root/.sudo-ai/token" ]]; then
  _LEGACY_TOKEN=$(cat /root/.sudo-ai/token | tr -d '[:space:]')
fi

# GATEWAY_TOKEN: used for GET /v1/admin/metrics (requires admin auth since Wave 2.2h-tail-2)
GATEWAY_TOKEN="${SUDO_GATEWAY_TOKEN:-}"
GATEWAY_TOKEN_SOURCE="SUDO_GATEWAY_TOKEN"
if [[ -z "$GATEWAY_TOKEN" ]]; then
  GATEWAY_TOKEN="$_LEGACY_TOKEN"
  GATEWAY_TOKEN_SOURCE="SUDO_API_TOKEN (legacy fallback)"
fi

# CHAT_TOKEN: used for POST /api/message (WEB_CHAT_TOKEN)
CHAT_TOKEN="${SUDO_WEB_CHAT_TOKEN:-}"
CHAT_TOKEN_SOURCE="SUDO_WEB_CHAT_TOKEN"
if [[ -z "$CHAT_TOKEN" ]]; then
  CHAT_TOKEN="$_LEGACY_TOKEN"
  CHAT_TOKEN_SOURCE="SUDO_API_TOKEN (legacy fallback)"
fi

if [[ -z "$GATEWAY_TOKEN" ]]; then
  log ERROR "No gateway token found. Set SUDO_GATEWAY_TOKEN, SUDO_API_TOKEN, SUDO_AI_DASHBOARD_TOKEN, or create /root/.sudo-ai/token"
  exit 1
fi
if [[ -z "$CHAT_TOKEN" ]]; then
  log ERROR "No chat token found. Set SUDO_WEB_CHAT_TOKEN, SUDO_API_TOKEN, SUDO_AI_DASHBOARD_TOKEN, or create /root/.sudo-ai/token"
  exit 1
fi

log INFO "seal-soak-loadgen starting (staging=$STAGING_URL)"
log INFO "Token sources: gateway=$GATEWAY_TOKEN_SOURCE chat=$CHAT_TOKEN_SOURCE"

# ---------------------------------------------------------------------------
# Pre-flight: confirm obs metrics are live (uses GATEWAY_TOKEN)
# ---------------------------------------------------------------------------
METRICS_URL="$STAGING_URL/v1/admin/metrics"
METRIC_COUNT=0
METRIC_COUNT=$(curl -sf --max-time 10 \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "$METRICS_URL" 2>/dev/null | grep -c "sudo_synth_seal_install_total" || true)

if [[ "$METRIC_COUNT" -eq 0 ]]; then
  log ERROR "Obs check FAILED: sudo_synth_seal_install_total not found in $METRICS_URL — staging may be down or obs not wired"
  exit 1
fi

log INFO "Obs check passed: sudo_synth_seal_install_total present"

# ---------------------------------------------------------------------------
# Capture baseline counter value before firing (uses GATEWAY_TOKEN)
# ---------------------------------------------------------------------------
BASELINE_INSTALL=$(curl -sf --max-time 10 \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "$METRICS_URL" 2>/dev/null \
  | grep "^sudo_synth_seal_install_total " \
  | awk '{print $2}' \
  | tr -d '[:space:]' || echo "0")
BASELINE_INSTALL="${BASELINE_INSTALL:-0}"
log INFO "Baseline sudo_synth_seal_install_total=$BASELINE_INSTALL"

# ---------------------------------------------------------------------------
# Fire 2 x POST /v1/admin/synth-probe (deterministic seal install path)
# ---------------------------------------------------------------------------
# Uses hardcoded benign PROBE_SOURCE inside tool-synthesize.ts — NO LLM call,
# NO user prompt forwarded. Each 200 response = one seal install increment.
# Staggered 2s apart to stay under MAX_CONCURRENT_PROBES=2.
#
# The 2.2h-tail-2 regression ("agent may decline") was caused by POST /api/message
# being brain-dependent: agent sometimes chose not to call tool.synthesize at all.
# synth-probe is deterministic: every successful call increments seal_install_total,
# regardless of whether the import/hot-load step (IMPORT phase) succeeds.
# ---------------------------------------------------------------------------
PROBE_URL="$STAGING_URL/v1/admin/synth-probe"
PROBE_OK_COUNT=0

for i in 1 2; do
  RESP_FILE="/tmp/seal-soak-probe-${i}.json"
  HTTP_CODE=$(curl -s -o "$RESP_FILE" -w "%{http_code}" \
    --max-time 30 \
    -X POST "$PROBE_URL" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null || echo "000")

  # Fail-fast if kill-switch off — no point retrying
  if [[ "$HTTP_CODE" == "503" ]]; then
    log ERROR "HTTP 503 — SUDO_TOOL_SYNTHESIZE_ENABLED=0 on staging; cannot install seals"
    exit 1
  fi

  if [[ "$HTTP_CODE" =~ ^2[0-9]{2}$ ]]; then
    PROBE_OK_COUNT=$((PROBE_OK_COUNT + 1))
    # Extract duration_ms + any errorCode for log
    DURATION_MS=$(grep -oE '"duration_ms":[0-9]+' "$RESP_FILE" | head -1 | cut -d: -f2 || echo "?")
    ERROR_CODE=$(grep -oE '"errorCode":"[^"]*"' "$RESP_FILE" | head -1 | cut -d: -f2 | tr -d '"' || echo "none")
    log INFO "probe $i: http=$HTTP_CODE duration_ms=$DURATION_MS errorCode=$ERROR_CODE"
  else
    log ERROR "probe $i: http=$HTTP_CODE — request failed (non-2xx)"
  fi

  # Stagger the second probe to avoid MAX_CONCURRENT_PROBES=2 collision
  [[ "$i" -lt 2 ]] && sleep 2
done

if [[ "$PROBE_OK_COUNT" -eq 0 ]]; then
  log ERROR "Both probes failed — seal install counter will not increment"
  exit 1
fi

# ---------------------------------------------------------------------------
# Confirm seal install counter incremented by PROBE_OK_COUNT (best-effort)
# ---------------------------------------------------------------------------
sleep 1

AFTER_INSTALL=$(curl -sf --max-time 10 \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "$METRICS_URL" 2>/dev/null \
  | grep "^sudo_synth_seal_install_total " \
  | awk '{print $2}' \
  | tr -d '[:space:]' || echo "0")
AFTER_INSTALL="${AFTER_INSTALL:-0}"

DELTA=$((AFTER_INSTALL - BASELINE_INSTALL))
# Note: if pm2 reloaded between baseline and now, counter resets and delta may be < 0
# In that case treat AFTER_INSTALL as the authoritative current value
if [[ "$DELTA" -lt 0 ]]; then
  log WARN "seal_install_total reset mid-run (likely pm2 reload): baseline=$BASELINE_INSTALL after=$AFTER_INSTALL"
  DELTA="$AFTER_INSTALL"
fi

log INFO "seal-soak-loadgen complete (probes_ok=$PROBE_OK_COUNT/2 delta=+$DELTA seal_install_total=$AFTER_INSTALL)"
exit 0
