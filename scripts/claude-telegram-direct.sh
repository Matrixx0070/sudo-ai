#!/bin/bash
# Claude Code ↔ Telegram Direct Control
# Full bidirectional integration like OpenClaw/Hermes

TOKEN="${TELEGRAM_BOT_TOKEN:-CHANGEME}"
CHAT_ID="${TELEGRAM_CHAT_ID:-CHANGEME}"
LOG="/tmp/claude-telegram.log"
OFFSET_FILE="/tmp/claude-telegram-offset.txt"
COMMAND_FILE="/tmp/claude-telegram-command.txt"
RESPONSE_FILE="/tmp/claude-telegram-response.txt"
SESSION_FILE="/tmp/claude-telegram-session.json"

mkdir -p /tmp

log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }

send_telegram() {
  local msg="$1"
  local parse_mode="${2:-Markdown}"
  # Handle long messages by splitting
  local len=${#msg}
  if [ "$len" -gt 4000 ]; then
    # Send as file
    echo "$msg" > /tmp/telegram-long-response.txt
    curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendDocument" \
      -F "chat_id=$CHAT_ID" \
      -F "document=@/tmp/telegram-long-response.txt" \
      -F "caption=Response (truncated - full output in file)" >> "$LOG" 2>&1
  else
    curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\":\"$CHAT_ID\",\"text\":$(echo "$msg" | jq -Rs .),\"parse_mode\":\"$parse_mode\"}" >> "$LOG" 2>&1
  fi
}

send_telegram_raw() {
  local msg="$1"
  curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":\"$CHAT_ID\",\"text\":$(echo "$msg" | jq -Rs .)}" >> "$LOG" 2>&1
}

# Initialize
[ ! -f "$OFFSET_FILE" ] && {
  curl -s "https://api.telegram.org/bot$TOKEN/getUpdates?offset=0" > /dev/null
  echo "1" > "$OFFSET_FILE"
}

log "=== Claude Code Direct Control Starting ==="
send_telegram "🔌 *Claude Code Direct Control Starting...*

Session initialized. Ready for commands."

while true; do
  offset=$(cat "$OFFSET_FILE" 2>/dev/null || echo "1")

  # Long polling with timeout
  resp=$(curl -s "https://api.telegram.org/bot$TOKEN/getUpdates?offset=$offset&timeout=30" 2>/dev/null || echo '{"error":"curl"}')

  # Check for errors
  if echo "$resp" | jq -e '.error' > /dev/null 2>&1; then
    log "API Error: $resp"
    sleep 5
    continue
  fi

  update_count=$(echo "$resp" | jq '.result | length')
  if [ "$update_count" = "0" ] || [ -z "$update_count" ]; then
    sleep 2
    continue
  fi

  # Process all updates (not just last)
  for i in $(seq 0 $((update_count - 1))); do
    update=$(echo "$resp" | jq ".result[$i]")
    update_id=$(echo "$update" | jq -r '.update_id')
    text=$(echo "$update" | jq -r '.message.text // ""')
    from_id=$(echo "$update" | jq -r '.message.from.id')
    chat=$(echo "$update" | jq -r '.message.chat.id')

    # Only process from authorized user
    if [ "$chat" != "$CHAT_ID" ]; then
      log "Ignoring unauthorized chat: $chat"
      echo $((update_id + 1)) > "$OFFSET_FILE"
      continue
    fi

    log "RECEIVED from $from_id: $text"

    # Handle commands
    case "$text" in
      /start)
        send_telegram "🤖 *Claude Code Direct Control*

I am your AI developer controlled via Telegram.

*Commands:*
- Any bash: \`ls /root\`, \`git status\`
- File ops: \`read file.ts\`, \`write test.txt hello\`
- Agents: \`spawn agent to build X\`
- Help: \`/help\`

*Session:* Active
*Mode:* Direct Control"
        ;;

      /help)
        send_telegram "📖 *Claude Code Commands*

*Bash Commands:*
\`ls /path\`, \`cd /path\`, \`pwd\`
\`git status\`, \`npm install\`, etc.

*File Operations:*
\`read <file>\` - Read file content
\`write <file> <content>\` - Write file
\`edit <file> <search> <replace>\` - Edit file

*Agent Control:*
\`spawn <task>\` - Spawn subagent
\`list agents\` - List available agents

*Session:*
\`/status\` - Current state
\`/history\` - Command history
\`/clear\` - Clear session

*System:*
\`/logs\` - Recent activity
\`/ping\` - Health check"
        ;;

      /status)
        session_info="📊 *Session Status*

Uptime: $(uptime -p 2>/dev/null || echo 'N/A')
Working Dir: $(pwd)
Pending: $(cat "$COMMAND_FILE" 2>/dev/null || echo 'None')
Response: $(cat "$RESPONSE_FILE" 2>/dev/null | head -1 || echo 'None')"
        send_telegram "$session_info"
        ;;

      /ping)
        send_telegram "🏓 Pong! Bridge operational. $(date)"
        ;;

      /logs)
        tail -20 "$LOG" | while read line; do
          send_telegram_raw "\`$line\`"
          sleep 0.1
        done
        ;;

      /clear)
        rm -f "$COMMAND_FILE" "$RESPONSE_FILE" /tmp/claude-telegram-response.txt
        send_telegram "✅ Session cleared"
        ;;

      *)
        # Regular command - write for Claude to process
        if [ -n "$text" ]; then
          # Acknowledge receipt
          short_cmd="${text:0:50}"
          [ ${#text} -gt 50 ] && short_cmd="$short_cmd..."
          send_telegram "⏳ Processing: $short_cmd"

          # Write command with timestamp
          cat > "$COMMAND_FILE" << CMD
{
  "command": $(echo "$text" | jq -Rs .),
  "timestamp": "$(date -Iseconds)",
  "from": "$from_id",
  "update_id": "$update_id"
}
CMD

          log "Command written to $COMMAND_FILE"
        fi
        ;;
    esac

    echo $((update_id + 1)) > "$OFFSET_FILE"
  done
done
