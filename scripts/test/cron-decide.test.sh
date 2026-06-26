#!/usr/bin/env bash
# =============================================================================
# Decision-logic test for scripts/lib/cron-decide.sh
# Sources the pure lib and feeds synthetic inputs — no pm2, no daemon, no I/O
# beyond a temp counter file. Run: bash scripts/test/cron-decide.test.sh
# =============================================================================
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/cron-decide.sh
source "$DIR/../lib/cron-decide.sh"

fail=0
ok() { echo "  ok: $1"; }
# eq <expected> <actual> <msg>
eq() {
  if [ "$1" = "$2" ]; then ok "$3"; else echo "FAIL: $3 (expected '$1' got '$2')"; fail=1; fi
}
# leak_is <expected:yes|no> <tsx> <esbuild> <app> <msg>
leak_is() {
  local want="$1"; shift
  local got=no
  if is_orphan_esbuild_leak "$1" "$2" "$3"; then got=yes; fi
  eq "$want" "$got" "$4"
}

# ---- is_orphan_esbuild_leak: the leak-gate truth table ----
# Healthy daemon (app running) + its transient esbuild child => NOT a leak (the churn bug).
leak_is no  0 1 yes "esbuild=1 + app running => no leak (was the churn bug)"
# App genuinely down + orphan esbuild => IS a leak (recovery preserved).
leak_is yes 0 1 no  "esbuild=1 + app down => leak (cleanup fires)"
# No esbuild => never a leak, regardless of app state.
leak_is no  0 0 no  "no esbuild => no leak"
# esbuild present but a tracked tsx also present => not the orphan condition.
leak_is no  1 1 no  "tsx present => not orphan condition"

# ---- decide_down_restart: consecutive-down gate (threshold 2) ----
eq defer   "$(decide_down_restart 0 2)" "down 0 cycles => defer"
eq defer   "$(decide_down_restart 1 2)" "down 1 cycle  => defer (deploy transition rides through)"
eq restart "$(decide_down_restart 2 2)" "down 2 cycles => restart (genuine death recovered)"
eq restart "$(decide_down_restart 3 2)" "down 3 cycles => restart"

# ---- counter persistence + port-bound reset semantics ----
CF="$(mktemp)"; trap 'rm -f "$CF"' EXIT
rm -f "$CF"
eq 0 "$(read_counter "$CF")" "missing counter file reads 0"
write_counter "$CF" "$(( $(read_counter "$CF") + 1 ))"   # one down cycle
eq 1 "$(read_counter "$CF")" "bump => 1"
write_counter "$CF" "$(( $(read_counter "$CF") + 1 ))"   # second down cycle
eq 2 "$(read_counter "$CF")" "bump => 2"
eq restart "$(decide_down_restart "$(read_counter "$CF")" 2)" "2 consecutive => restart"
write_counter "$CF" 0                                     # port-bound reset (Step 2)
eq 0 "$(read_counter "$CF")" "port-bound reset => 0"
printf 'garbage' > "$CF"
eq 0 "$(read_counter "$CF")" "non-numeric file reads 0 (safe)"

echo
if [ "$fail" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "SOME FAILED"; exit 1; fi
