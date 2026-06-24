#!/usr/bin/env bash
# mythos-verification-cron.sh
#
# Host-cron wrapper that finishes the Mythos harness verification automatically.
# Claude Code's durable cron registered session-only in this build (would never
# fire days out), so this runs from the system crontab — which fires regardless
# of whether Claude Code is open.
#
# Behaviour (idempotent, self-cleaning):
#   - Runs scripts/verify-harness-failure-rate.mjs, writes the latest report to
#     data/mythos-verification-result.log.
#   - If the post-deploy sample is still < 100 repo-exec attempts AND we're
#     before the deadline, it just waits (exits 0) — cron retries tomorrow.
#   - Once the sample is sufficient (or the deadline passes), it pushes a concise
#     verdict to the operator's Telegram (best-effort; token read at runtime from
#     config/.env, never hardcoded), drops a .DONE marker, and removes its OWN
#     crontab line (preserving all others).
#
# No secrets live in this file.

set -uo pipefail
cd /root/sudo-ai-v4 || exit 0

MIN_SAMPLE=100
DEADLINE="2026-07-15"          # give up waiting after this date
LOG="data/mythos-verification-result.log"
DONE="data/mythos-verification.DONE"
SELF="scripts/mythos-verification-cron.sh"

# Already finished on a prior run — do nothing.
[ -f "$DONE" ] && exit 0

# Produce the latest report.
node scripts/verify-harness-failure-rate.mjs > "$LOG" 2>&1 || exit 0

# Extract the AFTER exec attempt count (the "AFTER : attempts=N ..." exec line).
AFTER_ATTEMPTS=$(grep -m1 'AFTER : attempts=' "$LOG" | sed -E 's/.*attempts=([0-9]+).*/\1/')
[ -z "${AFTER_ATTEMPTS:-}" ] && AFTER_ATTEMPTS=0

TODAY=$(date -u +%Y-%m-%d)
READY=0
if [ "$AFTER_ATTEMPTS" -ge "$MIN_SAMPLE" ]; then READY=1; fi
if [[ "$TODAY" > "$DEADLINE" ]]; then READY=1; fi   # deadline reached → report whatever we have
[ "$READY" -eq 0 ] && exit 0                         # not ready yet — wait for more traffic

# --- Ready: compose verdict (the PRIMARY/SECONDARY lines + baseline reminder) ---
PRIMARY=$(grep -A2 'PRIMARY' "$LOG" | grep -E 'BEFORE|AFTER' | sed 's/^[[:space:]]*//')
SECONDARY=$(grep -A2 'SECONDARY' "$LOG" | grep -E 'BEFORE|AFTER' | sed 's/^[[:space:]]*//')
MSG=$(printf '🔬 Mythos harness verification (post-deploy sample=%s)\nBaseline → model-fixable exec refusal 28.2%%, preventable failure share 27.3%%, stuck/loop 1.1%%.\n\nPRIMARY (exec refusal):\n%s\n\nSECONDARY (failure share):\n%s\n\nWIN = AFTER model-fixable %% materially below 28.2%%. Full report: %s' \
  "$AFTER_ATTEMPTS" "$PRIMARY" "$SECONDARY" "$LOG")

# Best-effort Telegram push — read token+chat at runtime from config/.env (600).
if [ -f config/.env ]; then
  TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' config/.env | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
  CHAT=$(grep -E '^TELEGRAM_CHAT_ID=' config/.env | head -1 | cut -d= -f2- | cut -d, -f1 | tr -d '"'"'"' \r')
  if [ -n "${TOKEN:-}" ] && [ -n "${CHAT:-}" ]; then
    curl -s --max-time 20 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${CHAT}" \
      --data-urlencode "text=${MSG}" >/dev/null 2>&1 || true
  fi
fi

# Mark done and remove our own crontab line (preserve everything else).
printf '\n=== VERIFICATION COMPLETE (%s, sample=%s) ===\n%s\n' "$TODAY" "$AFTER_ATTEMPTS" "$MSG" >> "$LOG"
date -u +%Y-%m-%dT%H:%M:%SZ > "$DONE"
( crontab -l 2>/dev/null | grep -v "$SELF" ) | crontab - 2>/dev/null || true
exit 0
