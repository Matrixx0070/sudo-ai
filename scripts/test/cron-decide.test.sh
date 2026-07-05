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

# ---- is_app_proc: path-anchored daemon match (B7.1 false-negative fix) ----
# app_is <expected:yes|no> <argv> <msg>
app_is() {
  local want="$1" got=no
  if is_app_proc "$2"; then got=yes; fi
  eq "$want" "$got" "$3"
}
# The real prod argv (pm2 launches a direct node process) => MATCHES.
app_is yes "node /root/sudo-ai-v4/src/cli.ts"             "real daemon argv => app"
# The interpreter_args form (node --import tsx ...) => MATCHES.
app_is yes "node --import tsx /root/sudo-ai-v4/src/cli.ts" "node --import tsx form => app"
# A happy/Claude session whose PROMPT TEXT embeds the path mid-argv => NOT app
# (anchored at start; this is the proc running THIS very session).
app_is no  "node /usr/bin/happy --yolo -p [BATCH 7] ... node /root/sudo-ai-v4/src/cli.ts ..." "path mentioned mid-argv (happy session) => NOT app"
app_is no  "/usr/bin/node --no-warnings /usr/lib/node_modules/happy/dist/index.mjs -p ... /root/sudo-ai-v4/src/cli.ts" "happy launcher mentioning path => NOT app"
# Aether (different path / different command) => NEVER matches.
app_is no  "bash /root/aether-blueprint/eval/coding/tasks/06_rust_bug/verify.sh" "aether verify.sh => NOT app"
app_is no  "/tmp/aether-eval-rust-bug-target/debug/deps/rust_bug_fixture --quiet" "aether target binary => NOT app"
# esbuild / tsx children => NOT the anchored app proc.
app_is no  "/root/sudo-ai-v4/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.x" "esbuild child => NOT app"
app_is no  "node /usr/bin/something-else /root/sudo-ai-v4/src/cli.ts" "non-anchored node arg ordering => NOT app"
# A different home directory still anchors correctly (param form).
eq yes "$(is_app_proc 'node /opt/app/src/cli.ts' /opt/app && echo yes || echo no)" "param app_home matches its own daemon"
eq no  "$(is_app_proc 'node /root/sudo-ai-v4/src/cli.ts' /opt/app && echo yes || echo no)" "param app_home does not match a different home"

# ---- select_dup_kill_pids: duplicate kill-selection safety ----
# joinsel <pm2> <app...> => space-joined sorted selection (stable compare)
sel() { select_dup_kill_pids "$@" | tr '\n' ' ' | sed 's/ $//'; }
# Single healthy daemon (pm2 pid == only app pid) => select NOTHING.
eq ""    "$(sel 100 100)"          "single healthy daemon => kill nothing"
# Genuine duplicate: pm2 keeper + one orphan => select ONLY the orphan.
eq "200" "$(sel 100 100 200)"      "duplicate => select only the non-pm2 orphan"
# Two orphans + keeper => both orphans, NEVER the keeper.
eq "200 300" "$(sel 100 100 200 300)" "two orphans => select both, never pm2 pid"
# Keeper FIRST or LAST in the list — pm2 pid is never emitted.
eq "200" "$(sel 100 200 100)"      "keeper position-independent, pm2 never emitted"
# No pm2 keeper (app down / pm2 empty) => refuse to choose => NOTHING.
eq ""    "$(sel '' 200 300)"       "empty pm2 pid => select nothing (no trusted keeper)"
eq ""    "$(sel 0 200 300)"        "pm2 pid 0 => select nothing"
# pm2 keeper not among the candidates => ambiguous => NOTHING.
eq ""    "$(sel 100 200 300)"      "keeper absent from candidates => select nothing (ambiguous)"
# No candidates / single candidate that is not the keeper => NOTHING.
eq ""    "$(sel 100)"              "no app pids => select nothing"
eq ""    "$(sel 100 200)"          "lone non-keeper app pid => select nothing (no duplicate proof)"
# HARD INVARIANT: the pm2 pid must NEVER appear in any selection.
for case in "100 100 200" "100 100 200 300" "100 200 100" "100 200 300"; do
  # shellcheck disable=SC2086
  if select_dup_kill_pids $case | grep -qx 100; then
    echo "FAIL: pm2 pid 100 was selected for kill (case: $case)"; fail=1
  else
    ok "pm2 pid never selected (case: $case)"
  fi
done

echo
if [ "$fail" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "SOME FAILED"; exit 1; fi

# ---- file_age_s + decide_hang_restart: the hang-gate truth table ----
TMPF=$(mktemp)
touch "$TMPF"
NOW=$(date +%s)
AGE=$(file_age_s "$TMPF" "$NOW")
[ "$AGE" -ge 0 ] && [ "$AGE" -le 2 ] && ok "file_age_s: fresh file age ~0" || { echo "FAIL: file_age_s fresh (got $AGE)"; fail=1; }
eq "-1" "$(file_age_s /nonexistent/liveness.json "$NOW")" "file_age_s: missing file => -1"
rm -f "$TMPF"

# decide_hang_restart <age> <stale> <count> <threshold> <daemon_age> <min_daemon_age>
eq reset   "$(decide_hang_restart 30   600 1 2 5000 900)" "hang: fresh liveness => reset"
eq reset   "$(decide_hang_restart -1   600 1 2 5000 900)" "hang: missing file (-1) => reset (fail-safe)"
eq reset   "$(decide_hang_restart 9999 600 1 2 300  900)" "hang: stale but daemon young => reset (boot grace)"
eq count   "$(decide_hang_restart 9999 600 1 2 5000 900)" "hang: stale cycle 1/2 => count"
eq restart "$(decide_hang_restart 9999 600 2 2 5000 900)" "hang: stale cycle 2/2 => restart"
eq restart "$(decide_hang_restart 601  600 3 2 5000 900)" "hang: just-over-threshold stale, cycle 3 => restart"
