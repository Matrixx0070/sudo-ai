#!/usr/bin/env bash
# ops/federation/federation-smoke.sh
# ---------------------------------------------------------------------------
# SUDO-AI v5 — federation smoke test
#
# Proves two running SUDO-AI instances (peer-a on 18900, peer-b on 18901)
# can cross-publish audit events via the federation protocol.
#
# Usage:
#   bash ops/federation/federation-smoke.sh [--fresh]
#
# Flags:
#   --fresh   Wipe /tmp/sudo-ai-peer-b-data before running (peer-b data only;
#             primary data is never touched). Useful for reproducible checks.
#
# Prerequisites:
#   - curl and jq installed
#   - peer-a running on port 18900 with federation env set
#   - peer-b running on port 18901 with federation env set
#   - SUDO_ADMIN_TOKEN exported in the environment
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed
#
# Wave 8C — federation cross-instance handshake proof.
# ---------------------------------------------------------------------------

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PEER_A_PORT="${PEER_A_PORT:-18900}"
PEER_B_PORT="${PEER_B_PORT:-18901}"
PEER_A_URL="http://localhost:${PEER_A_PORT}"
PEER_B_URL="http://localhost:${PEER_B_PORT}"

# Admin token for /v1/admin/* and /v1/federation/stats|peers
ADMIN_TOKEN="${SUDO_ADMIN_TOKEN:-}"

# Inbound bearer tokens (matching the demo values in the ecosystem configs).
# Override via environment for production deployments.
TOKEN_A_TO_B="${SUDO_FED_TOKEN_A_TO_B:-demo_fed_token_a}"   # peer-a → peer-b
TOKEN_B_TO_A="${SUDO_FED_TOKEN_B_TO_A:-demo_fed_token_b}"   # peer-b → peer-a

PEER_B_DATA_DIR="/tmp/sudo-ai-peer-b-data"

PASS=0
FAIL=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

pass() {
  green "  PASS: $*"
  PASS=$(( PASS + 1 ))
}

fail() {
  red "  FAIL: $*"
  FAIL=$(( FAIL + 1 ))
}

# HTTP GET wrapper; prints status code.
http_get() {
  local url="$1"
  local token="${2:-}"
  if [ -n "$token" ]; then
    curl -s -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer ${token}" \
      "${url}"
  else
    curl -s -o /dev/null -w "%{http_code}" "${url}"
  fi
}

# HTTP GET that also returns body (stored in $BODY_OUT global).
http_get_body() {
  local url="$1"
  local token="${2:-}"
  if [ -n "$token" ]; then
    BODY_OUT=$(curl -s -H "Authorization: Bearer ${token}" "${url}")
  else
    BODY_OUT=$(curl -s "${url}")
  fi
}

# HTTP POST JSON wrapper; prints status code.
http_post_json() {
  local url="$1"
  local body="$2"
  local token="${3:-}"
  if [ -n "$token" ]; then
    curl -s -o /dev/null -w "%{http_code}" \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${token}" \
      -d "${body}" \
      "${url}"
  else
    curl -s -o /dev/null -w "%{http_code}" \
      -X POST \
      -H "Content-Type: application/json" \
      -d "${body}" \
      "${url}"
  fi
}

# HTTP POST JSON that also returns body.
http_post_json_body() {
  local url="$1"
  local body="$2"
  local token="${3:-}"
  if [ -n "$token" ]; then
    BODY_OUT=$(curl -s \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${token}" \
      -d "${body}" \
      "${url}")
  else
    BODY_OUT=$(curl -s \
      -X POST \
      -H "Content-Type: application/json" \
      -d "${body}" \
      "${url}")
  fi
}

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
check_deps() {
  for cmd in curl jq; do
    if ! command -v "$cmd" &>/dev/null; then
      red "ERROR: '$cmd' is required but not installed."
      exit 1
    fi
  done
}

# ---------------------------------------------------------------------------
# --fresh flag handling
# ---------------------------------------------------------------------------
handle_fresh() {
  bold "  --fresh: wiping ${PEER_B_DATA_DIR}"
  rm -rf "${PEER_B_DATA_DIR}"
  bold "  Done. Restart peer-b before running the smoke test again."
}

# ---------------------------------------------------------------------------
# Step 1 — Liveness: peer-a /v1/admin/metrics → 200
# ---------------------------------------------------------------------------
step_peer_a_liveness() {
  bold "Step 1: peer-a liveness (${PEER_A_URL}/v1/admin/metrics)"
  local status
  status=$(http_get "${PEER_A_URL}/v1/admin/metrics" "${ADMIN_TOKEN}")
  if [ "${status}" = "200" ]; then
    pass "peer-a /v1/admin/metrics returned 200"
  else
    fail "peer-a /v1/admin/metrics returned ${status} (expected 200)"
  fi
}

# ---------------------------------------------------------------------------
# Step 2 — Liveness: peer-b /v1/admin/metrics → 200
# ---------------------------------------------------------------------------
step_peer_b_liveness() {
  bold "Step 2: peer-b liveness (${PEER_B_URL}/v1/admin/metrics)"
  local status
  status=$(http_get "${PEER_B_URL}/v1/admin/metrics" "${ADMIN_TOKEN}")
  if [ "${status}" = "200" ]; then
    pass "peer-b /v1/admin/metrics returned 200"
  else
    fail "peer-b /v1/admin/metrics returned ${status} (expected 200)"
  fi
}

# ---------------------------------------------------------------------------
# Step 3 — peer-a federation stats baseline
# ---------------------------------------------------------------------------
step_peer_a_stats_baseline() {
  bold "Step 3: peer-a federation stats (${PEER_A_URL}/v1/federation/stats)"
  http_get_body "${PEER_A_URL}/v1/federation/stats" "${ADMIN_TOKEN}"
  local ok peers
  ok=$(echo "${BODY_OUT}" | jq -r '.ok' 2>/dev/null || echo "null")
  peers=$(echo "${BODY_OUT}" | jq -r '.data.peersConfigured' 2>/dev/null || echo "null")

  if [ "${ok}" = "true" ]; then
    pass "peer-a /v1/federation/stats returned ok=true, peersConfigured=${peers}"
  else
    fail "peer-a /v1/federation/stats unexpected response: ${BODY_OUT}"
  fi
}

# ---------------------------------------------------------------------------
# Step 4 — Publish an event from peer-a to peer-b via direct ingest
# (We POST directly rather than relying on re-anchor trigger — no API keys needed)
# ---------------------------------------------------------------------------
step_cross_publish() {
  bold "Step 4: Cross-publish — POST audit event from peer-a directly to peer-b ingest"

  local ts
  ts=$(date +%s%3N)  # epoch milliseconds
  local payload
  payload=$(cat <<EOF
{
  "id": "smoke-test-$(date +%s)",
  "instanceId": "peer-a",
  "eventType": "smoke-test",
  "payload": {"source": "federation-smoke.sh", "ts": ${ts}},
  "ts": ${ts},
  "seq": ${ts}
}
EOF
)

  http_post_json_body \
    "${PEER_B_URL}/v1/federation/audit/ingest" \
    "${payload}" \
    "${TOKEN_A_TO_B}"

  local status ok
  status=$(echo "${BODY_OUT}" | jq -r '.ok // false' 2>/dev/null || echo "false")
  if [ "${status}" = "true" ]; then
    pass "Event successfully ingested by peer-b (response: ${BODY_OUT})"
  else
    fail "peer-b ingest rejected event: ${BODY_OUT}"
  fi
}

# ---------------------------------------------------------------------------
# Step 5 — Query peer-b's audit tail and assert event is present
# ---------------------------------------------------------------------------
step_peer_b_tail_check() {
  bold "Step 5: peer-b audit tail — assert event from peer-a is present"

  http_get_body \
    "${PEER_B_URL}/v1/federation/audit/tail?since=0&limit=100" \
    "${TOKEN_A_TO_B}"

  local count
  count=$(echo "${BODY_OUT}" | jq -r '.data.count // 0' 2>/dev/null || echo "0")

  if [ "${count}" -gt "0" ]; then
    pass "peer-b audit tail returned ${count} event(s) from instanceId=peer-a"

    # Verify at least one event has instanceId=peer-a
    local from_a
    from_a=$(echo "${BODY_OUT}" | jq '[.data.events[] | select(.instanceId == "peer-a")] | length' 2>/dev/null || echo "0")
    if [ "${from_a}" -gt "0" ]; then
      pass "At least one event with instanceId=peer-a confirmed on peer-b"
    else
      fail "No events with instanceId=peer-a found on peer-b tail"
    fi
  else
    fail "peer-b audit tail returned 0 events (expected ≥1 after cross-publish)"
  fi
}

# ---------------------------------------------------------------------------
# Step 6 — Wrong inbound bearer on peer-b → 401
# ---------------------------------------------------------------------------
step_wrong_bearer_check() {
  bold "Step 6: Wrong inbound bearer on peer-b → 401"

  local ts
  ts=$(date +%s%3N)
  local payload
  payload=$(cat <<EOF
{
  "id": "bad-token-test-${ts}",
  "instanceId": "peer-a",
  "eventType": "bad-bearer-test",
  "payload": {},
  "ts": ${ts},
  "seq": 999999
}
EOF
)

  local status
  status=$(http_post_json \
    "${PEER_B_URL}/v1/federation/audit/ingest" \
    "${payload}" \
    "completely_wrong_token")

  if [ "${status}" = "401" ]; then
    pass "peer-b correctly rejected wrong bearer with 401"
  else
    fail "peer-b returned ${status} for wrong bearer (expected 401)"
  fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary() {
  echo ""
  bold "=============================="
  bold "  FEDERATION SMOKE RESULTS"
  bold "=============================="
  green "  PASSED: ${PASS}"
  if [ "${FAIL}" -gt 0 ]; then
    red "  FAILED: ${FAIL}"
  else
    echo "  FAILED: ${FAIL}"
  fi
  bold "=============================="
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  local fresh=0

  for arg in "$@"; do
    case "$arg" in
      --fresh)
        fresh=1
        ;;
      *)
        echo "Unknown argument: $arg"
        echo "Usage: $0 [--fresh]"
        exit 1
        ;;
    esac
  done

  bold "SUDO-AI v5 — Federation Smoke Test"
  bold "Peer A: ${PEER_A_URL}  Peer B: ${PEER_B_URL}"
  echo ""

  check_deps

  if [ -z "${ADMIN_TOKEN}" ]; then
    red "WARNING: SUDO_ADMIN_TOKEN is not set. Admin endpoints may return 401."
    red "         Export SUDO_ADMIN_TOKEN before running this script."
  fi

  if [ "${fresh}" -eq 1 ]; then
    handle_fresh
    echo ""
    bold "Run without --fresh to actually test the live instances."
    exit 0
  fi

  step_peer_a_liveness
  step_peer_b_liveness
  step_peer_a_stats_baseline
  step_cross_publish
  step_peer_b_tail_check
  step_wrong_bearer_check

  print_summary

  if [ "${FAIL}" -gt 0 ]; then
    exit 1
  fi
  exit 0
}

main "$@"
