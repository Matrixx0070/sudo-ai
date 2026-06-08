#!/bin/bash
# SUDO-AI Single-Command Install
# Usage (primary one-liner for real users):
#   curl -fsSL https://raw.githubusercontent.com/Matrixx0070/sudo-ai/main/install.sh | bash
# Or: npm i -g @matrixx0070/sudo-ai
#
# What it does (idempotent, safe, portable):
# - Ensures Node >=20 and pnpm (apt/corepack or instructions).
# - Prefers `npm install -g @matrixx0070/sudo-ai` (pulls prebuilt dist/server/cli.js for bin).
# - Fallback (dev/no-publish): shallow clone, pnpm i, build:cli, `npm install -g .` (registers global bin from source).
# - Runs `sudo-ai doctor` (env checks).
# - Runs the first-time setup wizard: `sudo-ai quickstart --force || sudo-ai setup`.
# - Starts healthy via pm2 (using ecosystem) or optional systemd service.
# - Verifies: `curl http://127.0.0.1:18900/health` == 200.
# - Leaves `sudo-ai` in PATH (global bin: chat, setup, doctor, status, start etc).
# - Logs: /tmp/sudo-ai-install.log
# - Supports SUDO_AI_HOME (defaults to $HOME/sudo-ai; ecosystem/service paths derive from it).
# - One command -> healthy service + global `sudo-ai` bin ready to use (`sudo-ai chat`).
#
# After: sudo-ai chat   # talk to the agent in a terminal UI
#        curl http://127.0.0.1:18900/health   # expect 200 OK
#
# Devs: git clone + pnpm still supported (this script also works from local clone via npm i -g . path).
set -euo pipefail

LOG=/tmp/sudo-ai-install.log
echo "=== SUDO-AI Wave1 Single-Command Install $(date) ===" | tee -a "$LOG"
echo "Args: $*" | tee -a "$LOG"

# --- Config / portable (match ecosystem) ---
SUDO_AI_HOME=${SUDO_AI_HOME:-$HOME/sudo-ai}
REPO_URL="https://github.com/Matrixx0070/sudo-ai.git"
GITHUB_RAW="https://raw.githubusercontent.com/Matrixx0070/sudo-ai/main"
HEALTH_URL="http://127.0.0.1:18900/health"
PM2_NAME="sudo-ai-v5"
BIN_NAME="sudo-ai"
PKG_NAME="@matrixx0070/sudo-ai"

# Idempotency: if bin in PATH and healthy, skip heavy work
if command -v "$BIN_NAME" >/dev/null 2>&1; then
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1 && curl -fsS --max-time 5 "$HEALTH_URL" | grep -q '"status":"ok"\|200'; then
    echo "[install] Idempotent: $BIN_NAME already in PATH and $HEALTH_URL healthy (200). Nothing to do." | tee -a "$LOG"
    "$BIN_NAME" --version 2>/dev/null || true
    echo "SUDO-AI ready. Run: $BIN_NAME chat  (terminal UI)"
    exit 0
  fi
fi

echo "[install] Starting SUDO-AI bootstrap (single command)." | tee -a "$LOG"

# --- OS / Linux only for v1 (per spec) ---
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[install] WARNING: Linux primary for v1 (Win/Mac via P1 shims + xai-code-v6). Proceeding with best effort." | tee -a "$LOG"
fi

# --- Ensure Node >= 20 ---
need_node() {
  if command -v node >/dev/null 2>&1; then
    NODEV=$(node --version | sed 's/v//;s/\..*//')
    if [ "$NODEV" -ge 20 ]; then
      echo "[install] Node $(node --version) OK." | tee -a "$LOG"
      return 0
    fi
  fi
  return 1
}

if ! need_node; then
  echo "[install] Installing Node 20+ (apt)..." | tee -a "$LOG"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq || true
    apt-get install -y -qq curl ca-certificates gnupg || true
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg || true
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list || true
    apt-get update -qq || true
    apt-get install -y -qq nodejs || true
  else
    echo "[install] No apt; please install Node 20+ manually (https://nodejs.org) then re-run." | tee -a "$LOG"
    exit 1
  fi
  need_node || { echo "[install] Node install failed. Manual required."; exit 1; }
fi

# --- Ensure pnpm (corepack preferred, fallback standalone) ---
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[install] Installing pnpm..." | tee -a "$LOG"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable || true
    corepack prepare pnpm@latest --activate || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    curl -fsSL https://get.pnpm.io/install.sh | sh - || true
    export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
    export PATH="$PNPM_HOME:$PATH"
  fi
fi
command -v pnpm >/dev/null 2>&1 || { echo "[install] pnpm required (install failed)."; exit 1; }
echo "[install] pnpm $(pnpm --version) OK." | tee -a "$LOG"

# --- Global bin install (preferred published path) ---
DID_GLOBAL=0
echo "[install] Attempting npm i -g $PKG_NAME (primary for users; pulls prebuilt dist/server/cli.js for bin)..." | tee -a "$LOG"
if npm install -g "$PKG_NAME" 2>&1 | tee -a "$LOG"; then
  if command -v "$BIN_NAME" >/dev/null 2>&1; then
    DID_GLOBAL=1
    echo "[install] Global via npm i -g succeeded." | tee -a "$LOG"
  fi
fi

# --- Fallback: source build + npm i -g . (for dev/pre-publish/local) ---
if [ "$DID_GLOBAL" -eq 0 ]; then
  echo "[install] npm global not sufficient or not published; using source bootstrap fallback (clone + build:cli + npm i -g .)..." | tee -a "$LOG"
  TMPD=/tmp/sudo-ai-bootstrap-$$
  mkdir -p "$TMPD"
  git clone --depth 1 "$REPO_URL" "$TMPD" 2>&1 | tee -a "$LOG" || {
    echo "[install] git clone failed; falling back to local if in tree..." | tee -a "$LOG"
    if [ -f "$SUDO_AI_HOME/package.json" ]; then
      TMPD="$SUDO_AI_HOME"
    else
      echo "[install] No source. Manual: git clone + pnpm i + pnpm build:cli + npm i -g ."; exit 1
    fi
  }
  pushd "$TMPD" >/dev/null
  echo "[install] pnpm install (in $TMPD)..." | tee -a "$LOG"
  pnpm install --prefer-offline 2>&1 | tail -5 | tee -a "$LOG" || true
  echo "[install] pnpm build:cli (ensures dist/server/cli.js for global bin)..." | tee -a "$LOG"
  pnpm build:cli 2>&1 | tail -3 | tee -a "$LOG" || npm run build:cli 2>&1 | tail -3 | tee -a "$LOG" || true
  echo "[install] npm install -g . (registers sudo-ai bin globally)..." | tee -a "$LOG"
  npm install -g . 2>&1 | tee -a "$LOG" || true
  popd >/dev/null
  [ "$TMPD" != "$SUDO_AI_HOME" ] && rm -rf "$TMPD" || true
  command -v "$BIN_NAME" >/dev/null 2>&1 && DID_GLOBAL=1
fi

if [ "$DID_GLOBAL" -eq 0 ]; then
  echo "[install] ERROR: No global $BIN_NAME after attempts. Check npm prefix (npm config get prefix), PATH, permissions." | tee -a "$LOG"
  echo "Try: npm install -g . from a clean clone, or sudo npm i -g sudo-ai" | tee -a "$LOG"
  exit 1
fi

echo "[install] $BIN_NAME now at: $(command -v "$BIN_NAME")" | tee -a "$LOG"
"$BIN_NAME" --version 2>/dev/null | tee -a "$LOG" || true

# --- Doctor (env health) ---
echo "[install] Running $BIN_NAME doctor (env checks)..." | tee -a "$LOG"
"$BIN_NAME" doctor --fix 2>&1 | tail -10 | tee -a "$LOG" || true

# --- Wave2 wizard hook (first-time/ongoing setup; integrates with Wave2 TUI) ---
echo "[install] Running first-time setup wizard (sudo-ai quickstart --force or sudo-ai setup)..." | tee -a "$LOG"
"$BIN_NAME" quickstart --force 2>&1 | tail -8 | tee -a "$LOG" || "$BIN_NAME" setup 2>&1 | tail -5 | tee -a "$LOG" || true
echo "[install] Wizard hook complete (Wave2 owns full impl; current may be basic readline, becomes rich Ink TUI)." | tee -a "$LOG"

# --- Start healthy (pm2 preferred; service optional) ---
echo "[install] Starting healthy stack (pm2 $PM2_NAME or service)..." | tee -a "$LOG"
if command -v pm2 >/dev/null 2>&1; then
  pm2 delete "$PM2_NAME" 2>/dev/null || true
  # Use ecosystem if present in SUDO_AI_HOME (portable)
  if [ -f "$SUDO_AI_HOME/ecosystem.config.cjs" ]; then
    pm2 start "$SUDO_AI_HOME/ecosystem.config.cjs" --only "$PM2_NAME" --update-env 2>&1 | tee -a "$LOG" || true
  else
    pm2 start pnpm --name "$PM2_NAME" -- cli 2>&1 | tee -a "$LOG" || true
  fi
  pm2 save 2>/dev/null || true
  sleep 3
else
  echo "[install] pm2 not found; attempting service setup..." | tee -a "$LOG"
  if [ -f "$SUDO_AI_HOME/scripts/sudo-ai-v5.service" ]; then
    # systemd does not expand ${VAR:-default}; substitute the real path on install.
    sed "s|__SUDO_AI_HOME__|$SUDO_AI_HOME|g" "$SUDO_AI_HOME/scripts/sudo-ai-v5.service" \
      | sudo tee /etc/systemd/system/sudo-ai-v5.service >/dev/null || true
    sudo systemctl daemon-reload || true
    sudo systemctl enable --now sudo-ai-v5 2>&1 | tee -a "$LOG" || true
  fi
fi

# --- Health verify (critical AC) ---
echo "[install] Verifying health (must be 200)..." | tee -a "$LOG"
for i in 1 2 3 4 5; do
  CODE=$(curl -fsS --max-time 8 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then
    echo "[install] SUCCESS: $HEALTH_URL -> 200 OK (healthy SUDO running)." | tee -a "$LOG"
    break
  fi
  echo "[install] Health $CODE (attempt $i/5), waiting..." | tee -a "$LOG"
  sleep 3
done

FINAL_CODE=$(curl -fsS --max-time 8 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo 000)
if [ "$FINAL_CODE" != "200" ]; then
  echo "[install] WARNING: Health not yet 200 (may need manual $BIN_NAME start or check logs). Continuing (bin is ready)." | tee -a "$LOG"
else
  echo "[install] Health confirmed 200." | tee -a "$LOG"
fi

# --- Final user-complete message ---
echo ""
echo "================================================================" | tee -a "$LOG"
echo "SUDO-AI installed via SINGLE COMMAND (Wave1)." | tee -a "$LOG"
echo "User-complete: one cmd -> global bin + healthy stack + wizard hook." | tee -a "$LOG"
echo "  $BIN_NAME --help          # CLI (start/stop/status/config/doctor/quickstart/setup/chat...)"
echo "  $BIN_NAME setup           # First-time / ongoing TUI wizard (Wave2)"
echo "  $BIN_NAME chat            # Talk to the agent in a terminal UI"
echo "  curl $HEALTH_URL          # expect 200 OK"
echo "  pm2 logs $PM2_NAME        # or journalctl for service"
echo "A self-hosted, owner-operated autonomous agent platform."
echo "See: BOOTSTRAP.md, README (install section), docs/cross-platform-control-guide.md"
echo "Log: $LOG"
echo "================================================================" | tee -a "$LOG"

# Optional: print a quick bin sanity
"$BIN_NAME" status 2>/dev/null | head -5 || true

exit 0
