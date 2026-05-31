#!/bin/bash
# Telegram Dev Team Listener — Bidirectional control
# Polls Telegram for commands, manages task queue, triggers Claude Code agents

set -e

TOKEN="${TELEGRAM_BOT_TOKEN:-CHANGEME}"
CHAT_ID="${TELEGRAM_CHAT_ID:-CHANGEME}"  # Mark's chat ID
BASE_DIR="/tmp/dev-team"
INBOX="$BASE_DIR/inbox"
TASKS="$BASE_DIR/tasks"
LOG="$BASE_DIR/listener.log"
OFFSET_FILE="$BASE_DIR/offset.txt"
COUNTER_FILE="$BASE_DIR/counter.txt"
STATE_FILE="$BASE_DIR/current-state.txt"

mkdir -p "$INBOX" "$TASKS"

log() {
  echo "[$(date -Iseconds)] $*" >> "$LOG"
}

send_telegram() {
  local msg="$1"
  local parse_mode="${2:-Markdown}"
  curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":\"$CHAT_ID\",\"text\":$(echo "$msg" | jq -Rs .),\"parse_mode\":\"$parse_mode\"}" \
    >> "$LOG" 2>&1
}

get_task_id() {
  local count=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")
  count=$((count + 1))
  echo "$count" > "$COUNTER_FILE"
  echo "TASK-$(date +%Y%m%d)-$(printf '%03d' $count)"
}

# Initialize offset if not exists
if [ ! -f "$OFFSET_FILE" ]; then
  curl -s "https://api.telegram.org/bot$TOKEN/getUpdates?offset=0" > /dev/null
  echo "1" > "$OFFSET_FILE"
fi

log "Listener starting with offset $(cat $OFFSET_FILE)"

while true; do
  offset=$(cat "$OFFSET_FILE")

  # Get updates with long polling (30s timeout)
  resp=$(curl -s "https://api.telegram.org/bot$TOKEN/getUpdates?offset=$offset&timeout=30" || echo '{"error":"curl failed"}')

  # Check for errors
  if echo "$resp" | jq -e '.error' > /dev/null 2>&1; then
    log "API Error: $resp"
    sleep 5
    continue
  fi

  # Get last update
  update_count=$(echo "$resp" | jq '.result | length')
  if [ "$update_count" = "0" ] || [ -z "$update_count" ]; then
    sleep 2
    continue
  fi

  last_update=$(echo "$resp" | jq '.result[-1]')
  update_id=$(echo "$last_update" | jq -r '.update_id')
  message=$(echo "$last_update" | jq -c '.message // .edited_message')

  # Skip if no message
  if [ "$message" = "null" ] || [ -z "$message" ]; then
    echo $((update_id + 1)) > "$OFFSET_FILE"
    continue
  fi

  from_id=$(echo "$message" | jq -r '.from.id')
  chat_id=$(echo "$message" | jq -r '.chat.id')
  text=$(echo "$message" | jq -r '.text // ""')
  message_id=$(echo "$message" | jq -r '.message_id')

  log "Received from $from_id: $text"

  # Only process messages from authorized chat
  if [ "$chat_id" != "$CHAT_ID" ]; then
    log "Ignoring message from unauthorized chat $chat_id"
    echo $((update_id + 1)) > "$OFFSET_FILE"
    continue
  fi

  # Process commands
  case "$text" in
    /dev\ *)
      task_text="${text#/dev }"
      task_id=$(get_task_id)

      # Create task file
      mkdir -p "$TASKS/$task_id"
      cat > "$INBOX/current-task.md" << TASK
# $task_id

**Received**: $(date -Iseconds)
**From**: Telegram (Frank)
**State**: PENDING_CONFIRMATION

## Task
$task_text
TASK

      # Update state
      echo "$task_id" > "$STATE_FILE"

      # Acknowledge
      send_telegram "✅ *$task_id RECEIVED*

Task queued. Waiting for your confirmation.

Reply:
  /approve — Start architect
  /reject <reason> — Cancel
  /pivot <new-direction> — Revise"

      log "Created task $task_id"
      ;;

    /approve)
      current_task=$(cat "$STATE_FILE" 2>/dev/null || echo "")
      if [ -z "$current_task" ]; then
        send_telegram "❌ No active task. Use /dev <task> to start."
      else
        # Check current gate and proceed
        gate=$(grep -oP 'State: \K[A-Z_]+' "$INBOX/current-task.md" 2>/dev/null || echo "UNKNOWN")
        echo "State: APPROVED_FOR_${gate}" >> "$INBOX/current-task.md"
        send_telegram "✅ Approved. Proceeding to next phase..."
        log "Approved gate for $current_task"

        # Trigger orchestrator if not running
        if ! pgrep -f "claude.*orchestrator" > /dev/null 2>&1; then
          cd /root && claude --agent telegram-dev-orchestrator &
          log "Triggered orchestrator"
        fi
      fi
      ;;

    /reject*)
      current_task=$(cat "$STATE_FILE" 2>/dev/null || echo "")
      if [ -z "$current_task" ]; then
        send_telegram "❌ No active task."
      else
        reason="${text#/reject }"
        echo "State: REJECTED" >> "$INBOX/current-task.md"
        echo "Rejection reason: $reason" >> "$INBOX/current-task.md"
        send_telegram "❌ Rejected: $reason

Task $current_task cancelled. Ready for new /dev command."
        rm -f "$STATE_FILE"
        log "Rejected $current_task: $reason"
      fi
      ;;

    /pivot*)
      current_task=$(cat "$STATE_FILE" 2>/dev/null || echo "")
      if [ -z "$current_task" ]; then
        send_telegram "❌ No active task."
      else
        new_direction="${text#/pivot }"
        cat >> "$INBOX/current-task.md" << PIVOT

## PIVOT ($(date -Iseconds))
$new_direction
PIVOT
        send_telegram "🔄 Pivot recorded for $current_task

New direction: $new_direction

Reply /approve to continue."
        log "Pivot for $current_task: $new_direction"
      fi
      ;;

    /status)
      current_task=$(cat "$STATE_FILE" 2>/dev/null || echo "NONE")
      if [ "$current_task" = "NONE" ]; then
        send_telegram "📊 No active task. Use /dev <task> to start."
      else
        state=$(grep -oP 'State: \K[A-Z_]+' "$INBOX/current-task.md" 2>/dev/null || echo "UNKNOWN")
        task_dir="$TASKS/$current_task"

        files_changed=$(find "$task_dir" -name "*.ts" -o -name "*.js" -o -name "*.tsx" 2>/dev/null | wc -l)

        send_telegram "📊 *Status: $current_task*

State: $state
Files changed: $files_changed
Task dir: \`$task_dir\`

Use /logs for recent activity."
      fi
      ;;

    /cancel)
      current_task=$(cat "$STATE_FILE" 2>/dev/null || echo "")
      if [ -z "$current_task" ]; then
        send_telegram "❌ No active task to cancel."
      else
        send_telegram "⏹️ Task $current_task cancelled.

Ready for new /dev command."
        rm -f "$STATE_FILE"
        log "Cancelled $current_task"
      fi
      ;;

    /logs*)
      lines="${lines:-50}"
      if [ -f "$LOG" ]; then
        tail -n "$lines" "$LOG" | while read line; do
          sleep 0.05
          send_telegram "\`$line\`" "Markdown"
        done
      else
        send_telegram "📄 No logs yet."
      fi
      ;;

    /deploy)
      current_task=$(cat "$STATE_FILE" 2>/dev/null || echo "")
      if [ -z "$current_task" ]; then
        send_telegram "❌ No completed task to deploy.

Deploy requires:
1. Security APPROVED
2. QA 100% PASS
3. Task in READY_TO_DEPLOY state"
      else
        # Check if ready
        if grep -q "QA_PASSED" "$INBOX/current-task.md" 2>/dev/null; then
          send_telegram "🚀 Deploying $current_task to production...

Will report progress here."
          echo "State: DEPLOYING" >> "$INBOX/current-task.md"

          # Trigger devops agent
          cd /root && claude --agent telegram-dev-devops --prompt "Deploy current task $current_task to production. Report each step via Telegram." &
          log "Deploy triggered for $current_task"
        else
          send_telegram "⚠️ Task $current_task not ready for deploy.

Required:
- [ ] Security APPROVED
- [ ] QA 100% PASS

Use /status to check."
        fi
      fi
      ;;

    /stage)
      current_task=$(cat "$STATE_FILE" 2>/dev/null || echo "")
      if [ -z "$current_task" ]; then
        send_telegram "❌ No active task."
      else
        send_telegram "🧪 Deploying $current_task to STAGING...

Will report progress here."
        echo "State: DEPLOYING_STAGING" >> "$INBOX/current-task.md"

        # Trigger devops for staging
        cd /root && claude --agent telegram-dev-devops --prompt "Deploy current task $current_task to STAGING only. Report each step via Telegram." &
        log "Staging deploy triggered for $current_task"
      fi
      ;;

    *)
      # Unknown command or conversational message
      if [[ "$text" == /* ]]; then
        send_telegram "❓ Unknown command: $text

Available:
/dev <task> — Start task
/approve — Approve gate
/reject <reason> — Reject
/pivot <direction> — Change direction
/status — Current state
/cancel — Abort task
/logs — Recent logs
/deploy — Deploy to prod
/stage — Deploy to staging"
      fi
      ;;
  esac

  # Update offset for next poll
  echo $((update_id + 1)) > "$OFFSET_FILE"
done
