#!/usr/bin/env bash
# capture-p99-baseline.sh — Wave 2.2h p99 latency baseline capture
#
# Fires N benign /api/message calls against staging (or any target), records
# per-call duration_ms, computes p50/p95/p99/max/avg, and emits a JSON
# baseline file for use by seal-soak-report.sh criterion #4.
#
# Usage:
#   bash scripts/capture-p99-baseline.sh [--count N] [--target host:port]
#
#   --count   N    Number of calls (default 100)
#   --target  H:P  Target host:port (default 127.0.0.1:18901 staging)
#
# Token resolution (priority order):
#   1. $GATEWAY_TOKEN env var
#   2. $SUDO_AI_DASHBOARD_TOKEN env var
#   3. /root/.sudo-ai/token file
#   4. pm2 env — WEB_CHAT_TOKEN from staging (apps[1])
#   5. Ecosystem config grep fallback
#   Aborts with clear message if unavailable.
#
# Output:
#   data/benchmarks/wave2.2h-seal-p99.json  (atomic write via .tmp)
#
# Exit codes:
#   0 — baseline written successfully
#   1 — auth unavailable or fatal error

set -euo pipefail
: "${TMPDIR:=/tmp}"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
COUNT=100
TARGET="127.0.0.1:18901"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count)
      shift
      COUNT="${1:-100}"
      ;;
    --count=*)
      COUNT="${1#--count=}"
      ;;
    --target)
      shift
      TARGET="${1:-127.0.0.1:18901}"
      ;;
    --target=*)
      TARGET="${1#--target=}"
      ;;
  esac
  shift 2>/dev/null || true
done

BASE_URL="http://${TARGET}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BENCHMARK_DIR="$PROJECT_DIR/data/benchmarks"
OUTPUT_FILE="$BENCHMARK_DIR/wave2.2h-seal-p99.json"
OUTPUT_TMP="$BENCHMARK_DIR/wave2.2h-seal-p99.json.tmp"
CSV_FILE="$TMPDIR/p99-baseline-$$.csv"

# ---------------------------------------------------------------------------
# Token resolution
# ---------------------------------------------------------------------------
TOKEN_SOURCE="none"
TOKEN=""

if [[ -n "${GATEWAY_TOKEN:-}" ]]; then
  TOKEN="$GATEWAY_TOKEN"
  TOKEN_SOURCE="env:GATEWAY_TOKEN"
fi

if [[ -z "$TOKEN" ]] && [[ -n "${SUDO_AI_DASHBOARD_TOKEN:-}" ]]; then
  TOKEN="$SUDO_AI_DASHBOARD_TOKEN"
  TOKEN_SOURCE="env:SUDO_AI_DASHBOARD_TOKEN"
fi

if [[ -z "$TOKEN" ]] && [[ -f "/root/.sudo-ai/token" ]]; then
  TOKEN=$(tr -d '[:space:]' < /root/.sudo-ai/token)
  TOKEN_SOURCE="file:/root/.sudo-ai/token"
fi

if [[ -z "$TOKEN" ]]; then
  # Strip ANSI color escape codes before extracting value
  _PM2_TOKEN=$(pm2 env 1 2>/dev/null | grep "WEB_CHAT_TOKEN" | sed 's/\x1b\[[0-9;]*m//g' | sed 's/.*WEB_CHAT_TOKEN[^:]*: *//' | tr -d '[:space:]' | head -1 || true)
  if [[ -n "$_PM2_TOKEN" ]]; then
    TOKEN="$_PM2_TOKEN"
    TOKEN_SOURCE="pm2-env:WEB_CHAT_TOKEN"
  fi
fi

if [[ -z "$TOKEN" ]]; then
  _ECO=$(grep -o "WEB_CHAT_TOKEN[^'\"]*['\"][^'\"]*" "$PROJECT_DIR/ecosystem.config.cjs" 2>/dev/null | grep -o "[A-Za-z0-9_=+\/-]\{20,\}" | head -1 || true)
  if [[ -n "$_ECO" ]]; then
    TOKEN="$_ECO"
    TOKEN_SOURCE="ecosystem.config.cjs"
  fi
fi

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: No auth token found. Set GATEWAY_TOKEN, SUDO_AI_DASHBOARD_TOKEN, or create /root/.sudo-ai/token" >&2
  echo "Alternatively ensure pm2 process sudo-ai-v5-staging is running (WEB_CHAT_TOKEN in pm2 env)" >&2
  exit 1
fi

echo "Token source: $TOKEN_SOURCE"
echo "Target: $BASE_URL"
echo "Count: $COUNT"

# ---------------------------------------------------------------------------
# Pre-flight: verify target is up
# ---------------------------------------------------------------------------
if ! curl -sf --max-time 5 -H "Authorization: Bearer $TOKEN" "$BASE_URL/health" >/dev/null 2>&1; then
  echo "ERROR: $BASE_URL/health not responding — is the server running?" >&2
  exit 1
fi
echo "Pre-flight: target healthy"

# ---------------------------------------------------------------------------
# Capture baseline seal install counter before run
# ---------------------------------------------------------------------------
INSTALL_BEFORE=$(curl -sf --max-time 5 \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/v1/admin/metrics" 2>/dev/null \
  | grep "^sudo_synth_seal_install_total " \
  | awk '{print $2}' \
  | tr -d '[:space:]' || echo "0")
INSTALL_BEFORE="${INSTALL_BEFORE:-0}"

# ---------------------------------------------------------------------------
# Run N iterations — append to CSV as we go (incremental save)
# ---------------------------------------------------------------------------
mkdir -p "$BENCHMARK_DIR"
echo "iteration,start_ms,end_ms,duration_ms,http_code" > "$CSV_FILE"

SUCCESSFUL=0
FAILED=0

echo "Starting $COUNT iterations..."

for i in $(seq 1 "$COUNT"); do
  PEER_ID="p99-baseline-${i}-$(date +%s%3N)"
  START_MS=$(date +%s%3N)
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 30 \
    -X POST "$BASE_URL/api/message" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"peerId\": \"$PEER_ID\", \"text\": \"Use tool.synthesize to create a simple tool that returns the current unix timestamp as an integer. Name it soak.timestamp-probe. This is a benign soak test call.\"}" \
    2>/dev/null || echo "000")
  END_MS=$(date +%s%3N)
  DURATION=$((END_MS - START_MS))

  echo "${i},${START_MS},${END_MS},${DURATION},${HTTP_CODE}" >> "$CSV_FILE"

  if [[ "$HTTP_CODE" =~ ^2[0-9]{2}$ ]]; then
    SUCCESSFUL=$((SUCCESSFUL + 1))
  else
    FAILED=$((FAILED + 1))
  fi

  # Progress every 10 iterations
  if [[ $(( i % 10 )) -eq 0 ]]; then
    echo "  ... $i/$COUNT done (ok=$SUCCESSFUL fail=$FAILED)"
  fi
done

echo "Run complete: successful=$SUCCESSFUL failed=$FAILED"

# ---------------------------------------------------------------------------
# Check seal install counter after run
# ---------------------------------------------------------------------------
INSTALL_AFTER=$(curl -sf --max-time 5 \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/v1/admin/metrics" 2>/dev/null \
  | grep "^sudo_synth_seal_install_total " \
  | awk '{print $2}' \
  | tr -d '[:space:]' || echo "0")
INSTALL_AFTER="${INSTALL_AFTER:-0}"
SYNTH_FIRED_COUNT=$(( ${INSTALL_AFTER%.*} - ${INSTALL_BEFORE%.*} ))
SYNTH_FIRED_COUNT=$(( SYNTH_FIRED_COUNT < 0 ? 0 : SYNTH_FIRED_COUNT ))

# ---------------------------------------------------------------------------
# Compute p50, p95, p99, max, avg from CSV (awk percentile)
# ---------------------------------------------------------------------------
STATS=$(awk -F',' 'NR>1 && $5~/^2/ {durations[++n]=$4} END {
  if (n==0) { print "0 0 0 0 0 0"; exit }
  # Simple insertion sort for small N
  for (i=2; i<=n; i++) {
    key=durations[i]; j=i-1
    while (j>=1 && durations[j]>key) { durations[j+1]=durations[j]; j-- }
    durations[j+1]=key
  }
  sum=0; for(i=1;i<=n;i++) sum+=durations[i]
  avg=sum/n
  p50=durations[int(n*0.50)+1]
  p95=durations[int(n*0.95)+1]
  p99=durations[int(n*0.99)+1]
  mx=durations[n]
  printf "%d %.1f %d %d %d %d\n", n, avg, p50, p95, p99, mx
}' "$CSV_FILE")

STATS_N=$(echo "$STATS" | awk '{print $1}')
STATS_AVG=$(echo "$STATS" | awk '{print $2}')
STATS_P50=$(echo "$STATS" | awk '{print $3}')
STATS_P95=$(echo "$STATS" | awk '{print $4}')
STATS_P99=$(echo "$STATS" | awk '{print $5}')
STATS_MAX=$(echo "$STATS" | awk '{print $6}')

CAPTURED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ---------------------------------------------------------------------------
# Emit JSON (atomic write via .tmp)
# ---------------------------------------------------------------------------
cat > "$OUTPUT_TMP" <<EOF
{
  "captured_at": "$CAPTURED_AT",
  "target": "$TARGET",
  "count": $COUNT,
  "successful": ${STATS_N:-0},
  "failed": $FAILED,
  "synth_fired_count": $SYNTH_FIRED_COUNT,
  "p50_ms": ${STATS_P50:-0},
  "p95_ms": ${STATS_P95:-0},
  "p99_ms": ${STATS_P99:-0},
  "max_ms": ${STATS_MAX:-0},
  "avg_ms": ${STATS_AVG:-0},
  "wave": "2.2h-seal-baseline",
  "seal_active": true,
  "token_source": "$TOKEN_SOURCE"
}
EOF

mv "$OUTPUT_TMP" "$OUTPUT_FILE"
rm -f "$CSV_FILE"

echo ""
echo "Baseline written to: $OUTPUT_FILE"
echo "  p50=${STATS_P50}ms  p95=${STATS_P95}ms  p99=${STATS_P99}ms  max=${STATS_MAX}ms  avg=${STATS_AVG}ms"
echo "  synth_fired_count=$SYNTH_FIRED_COUNT (out of $STATS_N successful calls)"
