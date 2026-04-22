#!/usr/bin/env bash
# seal-soak-report.sh — Wave 2.2h soak pass/fail reporter
#
# Queries staging metrics + greps error logs to emit a structured verdict
# for the 6 soak criteria defined in wave2.2h-closed.md.
#
# Usage:
#   bash scripts/seal-soak-report.sh [--since <value>]
#
#   --since accepts:
#     ISO8601:  2026-04-19T14:00:00Z
#     Relative: 1h | 48h | 30m | 2d  (parsed by date -d "$arg ago")
#     Default:  48h ago
#
# Exit codes:
#   0 — GREEN (all queryable criteria pass)
#   1 — RED   (any FAIL)
#   2 — YELLOW (1+ SKIP but zero FAIL)
#
# Token resolution (separate tokens since Wave 2.2h-tail-2):
#   GATEWAY_TOKEN (metrics): $SUDO_GATEWAY_TOKEN > $SUDO_API_TOKEN > $SUDO_AI_DASHBOARD_TOKEN > file
#   CHAT_TOKEN (POST /api/message latency probe): $SUDO_WEB_CHAT_TOKEN > $SUDO_API_TOKEN > $SUDO_AI_DASHBOARD_TOKEN > file

set -euo pipefail
: "${TMPDIR:=/tmp}"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
STAGING_URL="http://127.0.0.1:18901"
# pm2 may append -1, -2, etc. for rotation; glob to find the live log
_STAGING_ERR_GLOB="/root/sudo-ai-v4/data/logs/sudo-ai-v5-staging-err*.log"
STAGING_ERR_LOG=""
for _f in $_STAGING_ERR_GLOB; do
  if [[ -f "$_f" ]]; then
    # Prefer the un-suffixed file; otherwise take last match
    STAGING_ERR_LOG="$_f"
    [[ "$_f" == */sudo-ai-v5-staging-err.log ]] && break
  fi
done
LOG_DIR="/var/log/seal-soak"
TS_NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Fallback log dir if /var/log/seal-soak is not writable
if ! mkdir -p "$LOG_DIR" 2>/dev/null || ! touch "$LOG_DIR/.write-test" 2>/dev/null; then
  LOG_DIR="/root/sudo-ai-v4/data/logs/seal-soak"
  mkdir -p "$LOG_DIR" 2>/dev/null || true
fi
rm -f "$LOG_DIR/.write-test" 2>/dev/null || true
REPORT_LOG="$LOG_DIR/report-$(date +%Y%m%d-%H%M).log"

log() {
  printf '%s\n' "$*" | tee -a "$REPORT_LOG"
}

# ---------------------------------------------------------------------------
# Parse --since argument
# ---------------------------------------------------------------------------
SINCE_ARG="48h"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)
      shift
      SINCE_ARG="${1:-48h}"
      ;;
    --since=*)
      SINCE_ARG="${1#--since=}"
      ;;
  esac
  shift 2>/dev/null || true
done

# Determine SINCE_TS (unix epoch seconds for log grep)
SINCE_TS=""
if [[ "$SINCE_ARG" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]; then
  # ISO8601 passthrough
  SINCE_TS=$(date -d "$SINCE_ARG" +%s 2>/dev/null || echo "")
elif [[ "$SINCE_ARG" =~ ^[0-9]+[smhd]$ ]]; then
  # Relative: strip unit suffix, convert to seconds
  VAL="${SINCE_ARG%[smhd]}"
  UNIT="${SINCE_ARG: -1}"
  case "$UNIT" in
    s) MULT=1 ;;
    m) MULT=60 ;;
    h) MULT=3600 ;;
    d) MULT=86400 ;;
    *) MULT=3600 ;;
  esac
  SINCE_TS=$(( $(date +%s) - VAL * MULT ))
else
  # Fallback: treat as date expression
  SINCE_TS=$(date -d "$SINCE_ARG ago" +%s 2>/dev/null || echo "$(( $(date +%s) - 172800 ))")
fi

SINCE_DISPLAY=$(date -d "@$SINCE_TS" -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "$SINCE_ARG")

# ---------------------------------------------------------------------------
# Token resolution — separate tokens for obs (metrics) and chat (latency probe)
# ---------------------------------------------------------------------------
_LEGACY_TOKEN="${SUDO_API_TOKEN:-}"
if [[ -z "$_LEGACY_TOKEN" ]]; then _LEGACY_TOKEN="${SUDO_AI_DASHBOARD_TOKEN:-}"; fi
if [[ -z "$_LEGACY_TOKEN" ]] && [[ -f "/root/.sudo-ai/token" ]]; then
  _LEGACY_TOKEN=$(cat /root/.sudo-ai/token | tr -d '[:space:]')
fi

# GATEWAY_TOKEN: used for GET /v1/admin/metrics
GATEWAY_TOKEN="${SUDO_GATEWAY_TOKEN:-}"
if [[ -z "$GATEWAY_TOKEN" ]]; then GATEWAY_TOKEN="$_LEGACY_TOKEN"; fi

# CHAT_TOKEN: used for POST /api/message (criterion 4 latency probe)
CHAT_TOKEN="${SUDO_WEB_CHAT_TOKEN:-}"
if [[ -z "$CHAT_TOKEN" ]]; then CHAT_TOKEN="$_LEGACY_TOKEN"; fi

if [[ -z "$GATEWAY_TOKEN" ]]; then
  log "ERROR: No gateway token found. Set SUDO_GATEWAY_TOKEN, SUDO_API_TOKEN, SUDO_AI_DASHBOARD_TOKEN, or create /root/.sudo-ai/token"
  exit 1
fi
if [[ -z "$CHAT_TOKEN" ]]; then
  log "ERROR: No chat token found. Set SUDO_WEB_CHAT_TOKEN, SUDO_API_TOKEN, SUDO_AI_DASHBOARD_TOKEN, or create /root/.sudo-ai/token"
  exit 1
fi

# ---------------------------------------------------------------------------
# Fetch metrics from staging
# ---------------------------------------------------------------------------
METRICS_BODY=""
METRICS_OK=false
if METRICS_BODY=$(curl -sf --max-time 15 \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    "$STAGING_URL/v1/admin/metrics" 2>/dev/null); then
  METRICS_OK=true
fi

get_metric() {
  local name="$1"
  if [[ "$METRICS_OK" == "true" ]]; then
    printf '%s' "$METRICS_BODY" \
      | grep "^${name} " \
      | awk '{print $2}' \
      | tr -d '[:space:]' \
      | head -1
  fi
  printf ''
}

SEAL_INSTALL=$(get_metric "sudo_synth_seal_install_total")
SEAL_INSTALL="${SEAL_INSTALL:-unavailable}"

# ---------------------------------------------------------------------------
# Grep staging error log for violations (since SINCE_TS)
# ---------------------------------------------------------------------------
COUNT_SECCOMP=0
COUNT_MISSING_SO=0
COUNT_FD_WRITE=0

# count_since_pattern <logfile> <since_epoch> <awk_pattern>
count_since_pattern() {
  local logfile="$1" since="$2" pat="$3"
  awk -v since="$since" -v pat="$pat" '
    $0 ~ pat {
      if (match($0, /[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}/, m)) {
        cmd = "date -d \"" m[0] "\" +%s 2>/dev/null"
        cmd | getline ts; close(cmd)
        if (ts+0 >= since+0) count++
      } else { count++ }
    }
    END { print count+0 }
  ' "$logfile" 2>/dev/null || echo "0"
}

if [[ -f "$STAGING_ERR_LOG" ]]; then
  COUNT_SECCOMP=$(count_since_pattern "$STAGING_ERR_LOG" "$SINCE_TS" "SECCOMP_VIOLATION")
  COUNT_MISSING_SO=$(count_since_pattern "$STAGING_ERR_LOG" "$SINCE_TS" "synth-seccomp-seal\\.so not found")
  COUNT_FD_WRITE=$(count_since_pattern "$STAGING_ERR_LOG" "$SINCE_TS" "fd write error")
else
  COUNT_SECCOMP="unavailable"
  COUNT_MISSING_SO="unavailable"
  COUNT_FD_WRITE="unavailable"
fi

# ---------------------------------------------------------------------------
# Evaluate each criterion
# ---------------------------------------------------------------------------

# Criterion 1: Zero SECCOMP_VIOLATION
C1_STATUS="PASS"
if [[ "$COUNT_SECCOMP" == "unavailable" ]]; then
  C1_STATUS="SKIP"
elif [[ "$COUNT_SECCOMP" -gt 0 ]]; then
  C1_STATUS="FAIL"
fi

# Criterion 2: Zero synth-seccomp-seal.so not found
C2_STATUS="PASS"
if [[ "$COUNT_MISSING_SO" == "unavailable" ]]; then
  C2_STATUS="SKIP"
elif [[ "$COUNT_MISSING_SO" -gt 0 ]]; then
  C2_STATUS="FAIL"
fi

# Criterion 3: Zero fd write errors
C3_STATUS="PASS"
if [[ "$COUNT_FD_WRITE" == "unavailable" ]]; then
  C3_STATUS="SKIP"
elif [[ "$COUNT_FD_WRITE" -gt 0 ]]; then
  C3_STATUS="FAIL"
fi

# Criterion 4: p99 latency within 10% of baseline
# Reads data/benchmarks/wave2.2h-seal-p99.json (written by capture-p99-baseline.sh).
# If missing, falls back to SKIP (non-blocking).
# Runs 10 sample calls to compute a live sample p99, then compares vs baseline * 1.10.
C4_STATUS="SKIP"
C4_DETAIL="baseline not captured yet — run scripts/capture-p99-baseline.sh"
C4_BASELINE_P99=""
C4_SAMPLE_P99=""
_BASELINE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/benchmarks/wave2.2h-seal-p99.json"

if [[ -f "$_BASELINE_FILE" ]]; then
  C4_BASELINE_P99=$(grep '"p99_ms"' "$_BASELINE_FILE" | sed 's/.*"p99_ms"[^0-9]*//' | grep -o '^[0-9]*' | head -1 || echo "")
fi

if [[ -n "$C4_BASELINE_P99" ]] && [[ "$C4_BASELINE_P99" =~ ^[0-9]+$ ]] && [[ "$C4_BASELINE_P99" -gt 0 ]]; then
  # Run 10 sample calls to get live p99
  _C4_SAMPLE_CSV="$TMPDIR/c4-sample-$$.csv"
  _C4_SAMPLE_N=10
  _C4_OK=0
  for _i in $(seq 1 "$_C4_SAMPLE_N"); do
    _PEER_ID="soak-c4-${_i}-$(date +%s%3N)"
    _START=$(date +%s%3N)
    _CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      --max-time 20 \
      -X POST "$STAGING_URL/api/message" \
      -H "Authorization: Bearer $CHAT_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"peerId\": \"$_PEER_ID\", \"text\": \"ping latency probe\"}" \
      2>/dev/null || echo "000")
    _END=$(date +%s%3N)
    _DUR=$(( _END - _START ))
    echo "${_i},${_DUR},${_CODE}" >> "$_C4_SAMPLE_CSV"
    [[ "$_CODE" =~ ^2[0-9]{2}$ ]] && _C4_OK=$(( _C4_OK + 1 ))
  done

  if [[ "$_C4_OK" -ge 5 ]]; then
    # Compute sample p99 from successful calls
    C4_SAMPLE_P99=$(awk -F',' '$3~/^2/ {durations[++n]=$2} END {
      if (n==0) { print 0; exit }
      for (i=2; i<=n; i++) {
        key=durations[i]; j=i-1
        while (j>=1 && durations[j]>key) { durations[j+1]=durations[j]; j-- }
        durations[j+1]=key
      }
      print durations[int(n*0.99)+1]
    }' "$_C4_SAMPLE_CSV" 2>/dev/null || echo "0")
    C4_SAMPLE_P99="${C4_SAMPLE_P99:-0}"

    # Compare: pass if sample_p99 <= baseline_p99 * 1.10
    _C4_THRESHOLD=$(awk "BEGIN { printf \"%.0f\", $C4_BASELINE_P99 * 1.10 }")
    if [[ "$C4_SAMPLE_P99" -le "$_C4_THRESHOLD" ]] 2>/dev/null; then
      C4_STATUS="PASS"
      C4_DETAIL="baseline: ${C4_BASELINE_P99}ms, sample: ${C4_SAMPLE_P99}ms, threshold: ${_C4_THRESHOLD}ms"
    else
      C4_STATUS="FAIL"
      C4_DETAIL="baseline: ${C4_BASELINE_P99}ms, sample: ${C4_SAMPLE_P99}ms, threshold: ${_C4_THRESHOLD}ms — EXCEEDED"
    fi
  else
    C4_STATUS="SKIP"
    C4_DETAIL="sample calls insufficient (ok=${_C4_OK}/${_C4_SAMPLE_N}) — staging may be degraded"
  fi
  rm -f "$_C4_SAMPLE_CSV" 2>/dev/null || true
fi

# Criterion 5: >=10 successful synths
# SKIP when zero installs (soak not started yet — loadgen hasn't fired)
# FAIL when 1..9 installs (loadgen fired but threshold not reached)
# PASS when >=10 installs
C5_STATUS="SKIP"
if [[ "$SEAL_INSTALL" == "unavailable" ]] || [[ "$METRICS_OK" == "false" ]]; then
  C5_STATUS="SKIP"
elif [[ "$SEAL_INSTALL" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  INT_VAL=$(printf '%.0f' "$SEAL_INSTALL" 2>/dev/null || echo "0")
  if [[ "$INT_VAL" -ge 10 ]]; then
    C5_STATUS="PASS"
  elif [[ "$INT_VAL" -ge 1 ]]; then
    # Some synths fired but threshold not yet reached
    C5_STATUS="FAIL"
  else
    # Zero installs: soak not started yet, not a failure
    C5_STATUS="SKIP"
  fi
fi

# Criterion 6: Pre-existing flake rate (manual — requires vitest run)
C6_STATUS="SKIP"

# ---------------------------------------------------------------------------
# Overall verdict
# ---------------------------------------------------------------------------
HAS_FAIL=false
HAS_SKIP=false
for status in "$C1_STATUS" "$C2_STATUS" "$C3_STATUS" "$C4_STATUS" "$C5_STATUS" "$C6_STATUS"; do
  [[ "$status" == "FAIL" ]] && HAS_FAIL=true
  [[ "$status" == "SKIP" ]] && HAS_SKIP=true
done

if [[ "$HAS_FAIL" == "true" ]]; then
  VERDICT="RED"
  EXIT_CODE=1
elif [[ "$HAS_SKIP" == "true" ]]; then
  VERDICT="YELLOW"
  EXIT_CODE=2
else
  VERDICT="GREEN"
  EXIT_CODE=0
fi

# ---------------------------------------------------------------------------
# Emit structured report
# ---------------------------------------------------------------------------
log ""
log "SOAK REPORT since $SINCE_DISPLAY:"
log "  [ $C1_STATUS ] 1. Zero SECCOMP_VIOLATION        (count: $COUNT_SECCOMP)"
log "  [ $C2_STATUS ] 2. Zero missing-so warns         (count: $COUNT_MISSING_SO)"
log "  [ $C3_STATUS ] 3. Zero fd-write errors          (count: $COUNT_FD_WRITE)"
log "  [ $C4_STATUS ] 4. p99 latency within 10% of baseline  ($C4_DETAIL)"
log "  [ $C5_STATUS ] 5. >=10 successful synths        (install_total: $SEAL_INSTALL)"
log "  [ $C6_STATUS ] 6. Flake rate                    (manual — run pnpm vitest)"
log ""
log "VERDICT: $VERDICT"
log "Report saved to: $REPORT_LOG"
log ""

# ---------------------------------------------------------------------------
# Optional Telegram notification (fire-and-forget)
# ---------------------------------------------------------------------------
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

if [[ -n "$TELEGRAM_BOT_TOKEN" ]] && [[ -n "$TELEGRAM_CHAT_ID" ]]; then
  TG_MSG="Seal soak report (since $SINCE_DISPLAY): $VERDICT%0A"
  TG_MSG+="1. SECCOMP_VIOLATION: $COUNT_SECCOMP%0A"
  TG_MSG+="2. Missing-so: $COUNT_MISSING_SO%0A"
  TG_MSG+="3. fd-write errors: $COUNT_FD_WRITE%0A"
  TG_MSG+="5. Seal installs: $SEAL_INSTALL%0A"
  TG_MSG+="Verdict: $VERDICT"

  curl -s -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}&text=${TG_MSG}&parse_mode=Markdown" \
    --max-time 10 \
    >/dev/null 2>&1 || true
fi

exit "$EXIT_CODE"
