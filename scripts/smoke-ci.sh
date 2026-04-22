#!/usr/bin/env bash
# @file scripts/smoke-ci.sh
# @description Wave 8F: One-stop CI smoke gate for SUDO-AI v5.
#
# Steps:
#   1. Typecheck (tsc --noEmit)
#   2. Full vitest suite
#   3. Fuzz vitest suite (tests/fuzz/)
#   4. Short soak test (30s, 5rps) — skipped if pm2 process not running
#   5. Print summary
#
# Exit code: non-zero on any failure.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

STEP_PASS=0
STEP_FAIL=0
SUMMARY=()

pass() { echo -e "${GREEN}[PASS]${NC} $1"; STEP_PASS=$((STEP_PASS + 1)); SUMMARY+=("PASS: $1"); }
fail() { echo -e "${RED}[FAIL]${NC} $1"; STEP_FAIL=$((STEP_FAIL + 1)); SUMMARY+=("FAIL: $1"); }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

echo ""
echo "============================================================"
echo "  SUDO-AI v5 — Wave 8F CI Smoke Gate"
echo "============================================================"
echo ""

# ---------------------------------------------------------------------------
# Step 1: TypeScript type check
# ---------------------------------------------------------------------------
info "Step 1: TypeScript type check (tsc --noEmit)"
if npx tsc --noEmit 2>&1; then
  pass "TypeScript type check"
else
  fail "TypeScript type check"
fi

# ---------------------------------------------------------------------------
# Step 2: Full vitest suite
# ---------------------------------------------------------------------------
info "Step 2: Full vitest suite (npx vitest run)"
if npx vitest run 2>&1; then
  pass "Full vitest suite"
else
  fail "Full vitest suite"
fi

# ---------------------------------------------------------------------------
# Step 3: Fuzz vitest suite
# ---------------------------------------------------------------------------
info "Step 3: Fuzz vitest suite (tests/fuzz/)"
if npx vitest run tests/fuzz/ 2>&1; then
  pass "Fuzz vitest suite"
else
  fail "Fuzz vitest suite"
fi

# ---------------------------------------------------------------------------
# Step 4: Short soak test (if pm2 process is running)
# ---------------------------------------------------------------------------
info "Step 4: Short soak test"

PM2_RUNNING=false
if command -v pm2 &>/dev/null; then
  if pm2 pid sudo-ai-v5 &>/dev/null 2>&1; then
    PID=$(pm2 pid sudo-ai-v5 2>/dev/null || echo "")
    if [[ -n "$PID" && "$PID" != "0" ]]; then
      PM2_RUNNING=true
    fi
  fi
fi

if [ "$PM2_RUNNING" = true ]; then
  SOAK_TOKEN="${SUDO_ADMIN_TOKEN:-}"
  SOAK_ARGS="--duration=30 --rps=5 --target=http://localhost:18900"
  if [[ -n "$SOAK_TOKEN" ]]; then
    SOAK_ARGS="$SOAK_ARGS --token=$SOAK_TOKEN"
  else
    info "SUDO_ADMIN_TOKEN not set — soak runs unauthenticated (may get 401s)"
  fi

  info "pm2 sudo-ai-v5 is running — executing soak test"
  if npx tsx scripts/soak.ts $SOAK_ARGS 2>&1; then
    pass "Soak test (30s @ 5rps)"
  else
    fail "Soak test (30s @ 5rps)"
  fi
else
  info "pm2 sudo-ai-v5 not running — skipping soak test"
  SUMMARY+=("SKIP: Soak test (pm2 sudo-ai-v5 not running)")
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  CI SMOKE GATE SUMMARY"
echo "============================================================"
for line in "${SUMMARY[@]}"; do
  if [[ "$line" == PASS* ]]; then
    echo -e "  ${GREEN}${line}${NC}"
  elif [[ "$line" == FAIL* ]]; then
    echo -e "  ${RED}${line}${NC}"
  else
    echo -e "  ${YELLOW}${line}${NC}"
  fi
done
echo ""
echo "  Steps passed: $STEP_PASS"
echo "  Steps failed: $STEP_FAIL"
echo ""

if [ "$STEP_FAIL" -gt 0 ]; then
  echo -e "${RED}RESULT: FAIL${NC}"
  exit 1
else
  echo -e "${GREEN}RESULT: PASS${NC}"
  exit 0
fi
