#!/bin/sh
set -eu

# Resolve the project root from this script's location (scripts/ lives at <root>/scripts);
# allow an explicit override via SUDO_AI_HOME.
SUDO_HOME="${SUDO_AI_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"

echo "SelfBuild bootstrap"

# 1. Install hooks
bash ${SUDO_HOME}/scripts/install-self-build-hooks.sh

# 2. Create + checkout self-build branch
cd ${SUDO_HOME}
if git show-ref --verify --quiet refs/heads/self-build; then
  echo "Branch self-build already exists"
  git checkout self-build
else
  git checkout -b self-build main
fi

# 3. Ensure config/.env has self-build env vars
if ! grep -q '^SUDO_SELF_BUILD_MODE=' config/.env 2>/dev/null; then
  cat >> config/.env <<EOF

# ---- Wave SelfBuild ----
SUDO_SELF_BUILD_MODE=1
SUDO_DAILY_LLM_BUDGET_USD=10
SUDO_SELF_BUILD_MIN_ALIGN_SCORE=0.6
SUDO_SELF_BUILD_MAX_ITERATIONS=6
EOF
fi

# 4. Create the report + journal dirs
mkdir -p ${SUDO_HOME}/data/self-build-reports
touch ${SUDO_HOME}/data/self-build-reports/journal.md

# 5. Tell pm2 to reload with new env
pm2 reload sudo-ai-v5 --update-env

# 6. Confirm
echo "---"
echo "Branch: $(git branch --show-current)"
echo "pm2 status:"
pm2 describe sudo-ai-v5 | grep -E 'status|uptime' | head -3
echo "---"
echo "Kickoff complete. Autopilot starts on next cron tick (<= 30 min)."
echo "Watch: tail -f ${SUDO_HOME}/data/logs/sudo-ai-v5-out-0.log | grep self-build"
echo "Kill: pm2 set sudo-ai-v5:SUDO_SELF_BUILD_DISABLE 1 && pm2 reload sudo-ai-v5 --update-env"
