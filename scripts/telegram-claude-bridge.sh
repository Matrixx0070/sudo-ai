#!/bin/bash
# Telegram ↔ Claude Code Bridge
# Forwards Telegram messages to Claude Code and sends responses back

TOKEN="${TELEGRAM_BOT_TOKEN:-CHANGEME}"
CHAT_ID="${TELEGRAM_CHAT_ID:-CHANGEME}"
LOG="/tmp/claude-telegram-bridge.log"
OFFSET_FILE="/tmp/claude-telegram-offset.txt"

log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }

send_telegram() {
  local msg="$1"
  curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":\"$CHAT_ID\",\"text\":$(echo "$msg" | jq -Rs .),\"parse_mode\":\"Markdown\"}" >> "$LOG" 2>&1
}

send_telegram_long() {
  local file="$1"
  curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendDocument" \
    -F "chat_id=$CHAT_ID" \
    -F "document=@$file" \
    -F "caption=Claude Code Response (truncated)" >> "$LOG" 2>&1
}

[ ! -f "$OFFSET_FILE" ] && echo "1" > "$OFFSET_FILE"
log "=== Claude Code Bridge Starting ==="

while true; do
  offset=$(cat "$OFFSET_FILE")
  resp=$(curl -s "https://api.telegram.org/bot$TOKEN/getUpdates?offset=$offset&timeout=30" || echo '{}')

  update_count=$(echo "$resp" | jq '.result | length')
  if [ "$update_count" = "0" ]; then sleep 2; continue; fi

  last=$(echo "$resp" | jq '.result[-1]')
  update_id=$(echo "$last" | jq -r '.update_id')
  text=$(echo "$last" | jq -r '.message.text // ""')
  from_id=$(echo "$last" | jq -r '.message.from.id')

  if [ -z "$text" ] || [ "$from_id" != "$CHAT_ID" ]; then
    echo $((update_id + 1)) > "$OFFSET_FILE"
    continue
  fi

  log "FROM TELEGRAM: $text"

  # Write prompt for Claude to read
  PROMPT_FILE="/tmp/claude-telegram-prompt.txt"
  echo "$text" > "$PROMPT_FILE"

  # Acknowledge
  short_text="${text:0:40}"
  [ ${#text} -gt 40 ] && short_text="$short_text..."
  send_telegram "⏳ $short_text"

  echo $((update_id + 1)) > "$OFFSET_FILE"
done
