# shellcheck shell=bash
# =============================================================================
# cron-decide.sh — pure decision helpers for cron-ensure-alive.sh
#
# PURE LIBRARY: defines functions only, performs NO action when sourced (no
# top-level side effects, no `set -e`, no I/O). Sourced by both the live
# keepalive script and the decision-logic test so the two can never diverge.
#
# Each function takes its inputs as ARGUMENTS (never reads the environment or
# runs pm2/ss itself) so it can be exercised with synthetic inputs in a test.
# =============================================================================

# is_orphan_esbuild_leak <tsx_count> <esbuild_count> <app_running:yes|no>
#
# Returns 0 (true ⇒ the esbuild process(es) are an orphaned leak worth cleaning)
# ONLY when there are esbuild processes, NO tracked tsx process, AND the app is
# genuinely NOT running. The trailing app-running guard is the fix for the
# self-inflicted restart churn: the prod daemon runs as `node --import tsx
# src/cli.ts` (argv `node .../src/cli.ts`), which the `tsx src/cli.ts` pgrep
# pattern never matches, so tsx_count is permanently 0. Without the app-running
# guard, the healthy daemon's OWN transient esbuild child was misread as an
# orphan and the daemon was bounced (`pm2 delete + start`) every time esbuild
# appeared while the daemon was >5min old. An esbuild is only truly orphaned
# when the app it belongs to is gone.
is_orphan_esbuild_leak() {
  local tsx="${1:-0}" esbuild="${2:-0}" app="${3:-yes}"
  [ "$esbuild" -gt 0 ] && [ "$tsx" -eq 0 ] && [ "$app" = "no" ]
}

# decide_down_restart <consecutive_down_count> <threshold>
#
# Echoes "restart" when the daemon has been observed down for >= threshold
# consecutive cron cycles, else "defer". Lets a pm2 restart/deploy transition
# (down for ~1 cycle) resolve on its own while a genuine death (down for
# >= threshold cycles) is still recovered. The caller increments + persists the
# count; this function only decides.
decide_down_restart() {
  local count="${1:-0}" threshold="${2:-2}"
  if [ "$count" -ge "$threshold" ]; then echo restart; else echo defer; fi
}

# read_counter <file> — echo the non-negative integer in <file>, or 0 when the
# file is absent / empty / non-numeric (never errors under `set -e`).
read_counter() {
  local c
  c=$(cat "$1" 2>/dev/null) || c=0
  case "$c" in ''|*[!0-9]*) c=0 ;; esac
  echo "$c"
}

# write_counter <file> <value> — best-effort persist (never errors under set -e).
write_counter() {
  echo "$2" > "$1" 2>/dev/null || true
}
