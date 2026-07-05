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

# file_age_s <file> <now_epoch> — echo the file's age in seconds relative to
# <now_epoch>, or -1 when the file is missing/unreadable (never errors under
# `set -e`). -1 is the explicit "no liveness signal" sentinel: callers MUST
# treat it as "do not restart" (fresh boot / feature not deployed yet).
file_age_s() {
  local mtime
  mtime=$(stat -c %Y "$1" 2>/dev/null) || { echo -1; return 0; }
  case "$mtime" in ''|*[!0-9]*) echo -1; return 0 ;; esac
  echo $(( ${2:-0} - mtime ))
}

# decide_hang_restart <liveness_age_s> <stale_threshold_s> <consec_count>
#                     <consec_threshold> <daemon_age_s> <min_daemon_age_s>
#
# Hang gate for a HUNG-BUT-ALIVE daemon: the port is bound (so the down-gate
# never fires) but the in-process watchdog stopped refreshing the liveness
# file — a blocked event loop. Echoes exactly one of:
#   reset   — liveness fresh, file missing (-1), or daemon too young: clear the
#             consecutive-stale counter (fail-safe: missing signal ≠ hang)
#   count   — liveness stale but not yet observed for enough cycles: increment
#   restart — stale for >= threshold consecutive cycles on a mature daemon
# The caller persists the counter; this function only decides.
decide_hang_restart() {
  local age="${1:--1}" stale="${2:-600}" count="${3:-0}" threshold="${4:-2}"
  local daemon_age="${5:-0}" min_daemon_age="${6:-900}"
  if [ "$age" -lt 0 ] || [ "$age" -lt "$stale" ]; then echo reset; return 0; fi
  if [ "$daemon_age" -lt "$min_daemon_age" ]; then echo reset; return 0; fi
  if [ "$count" -ge "$threshold" ]; then echo restart; else echo count; fi
}

# =============================================================================
# Anchored app-process matching + duplicate-daemon kill-selection.
#
# Replaces the legacy stale `tsx src/cli.ts` pgrep pattern, which never matched
# the real prod argv `node /root/sudo-ai-v4/src/cli.ts` (pm2 launches it as a
# direct node process) — so the duplicate-detection arm + the hard-reset pkill
# were both inert (false-NEGATIVE: a genuine second daemon went undetected).
#
# PARANOIA NOTE (shared box): a naive `pgrep -f` for the path matches ANY proc
# whose command line merely MENTIONS it — e.g. this very happy/Claude session,
# whose prompt text embeds `node /root/sudo-ai-v4/src/cli.ts`. The pattern is
# therefore ANCHORED at the start of the command line (`^node ...`) so only a
# process actually EXECUTING the daemon matches; a prompt that quotes the path
# in a later argument does not. Aether runs from /root/aether-blueprint and
# never matches.
# =============================================================================

# app_proc_regex [app_home] — echo the ERE that matches ONLY the prod daemon
# argv `node [--import tsx] <app_home>/src/cli.ts`, anchored at command-line
# start. Default app_home is the prod path. app_home is a controlled deploy
# path assumed free of regex metacharacters other than `.` (which is escaped).
app_proc_regex() {
  local home="${1:-/root/sudo-ai-v4}" esc
  esc=$(printf '%s' "$home/src/cli.ts" | sed 's/\./\\./g')
  printf '^node( --import tsx)? %s([[:space:]]|$)' "$esc"
}

# is_app_proc <argv> [app_home] — true (0) when <argv> is the prod daemon's
# command line. Pure: matches a string, runs no pm2/pgrep, reads no env.
is_app_proc() {
  printf '%s' "${1:-}" | grep -Eq "$(app_proc_regex "${2:-/root/sudo-ai-v4}")"
}

# select_dup_kill_pids <pm2_pid> <app_pid...> — echo (one per line) the app pids
# that are SAFE to kill as duplicate daemons. Conservative by construction:
#   * emits NOTHING unless there are >1 app pids (no duplicate ⇒ nothing);
#   * emits NOTHING when <pm2_pid> is empty/0 (no trusted keeper to protect);
#   * emits NOTHING when <pm2_pid> is not among the candidates (ambiguous — we
#     refuse to guess which surviving proc is the real one);
#   * NEVER emits <pm2_pid> itself (the pm2-managed daemon is always protected).
# So the single-healthy-daemon case selects nothing, and a genuine orphan dup
# alongside the managed daemon selects ONLY the orphan.
select_dup_kill_pids() {
  local pm2="${1:-}"; shift 2>/dev/null || true
  case "$pm2" in ''|0) return 0 ;; esac
  local apps=("$@") p found=no
  [ "${#apps[@]}" -gt 1 ] || return 0
  for p in "${apps[@]}"; do [ "$p" = "$pm2" ] && found=yes; done
  [ "$found" = yes ] || return 0
  for p in "${apps[@]}"; do [ "$p" = "$pm2" ] || echo "$p"; done
}
