#!/usr/bin/env bash
# cleanup-root.sh
# Moves all dev-artifact files from the project root into archive/.
# Safe to re-run: skips files that have already been moved.
# Usage: bash scripts/cleanup-root.sh  (run from project root)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="${ROOT}/archive"

mkdir -p "${ARCHIVE}"

echo "==> Archiving known dev-artifact files..."

# ---- Explicit list from the task spec --------------------------------
EXPLICIT_FILES=(
  CHATGPT-AGENT-BLUEPRINT.ts
  CHATGPT-AGENT-MODE-RESEARCH.html
  CHATGPT-AGENT-MODE-RESEARCH.txt
  CONSCIOUSNESS-ARCHITECTURE-SPEC.md
  GROWTH_TRACKER.md
  LEARNING_JOURNAL.md
  api-server.ts
  battle-kv-store.ts
  battle-task-queue.ts
  challenge-api.ts
  challenge-eventbus.ts
  challenge-fsm.ts
  deep-test-dag.ts
  deep-test-db.ts
  deep-test-router.ts
  deep-test-store.ts
  deep-test-validator.ts
  event-bus.ts
  eventbus-history.json
  fix2-api.ts
  fix2-eventbus.ts
  heartbeat_report.json
  url-shortener.ts
)

for f in "${EXPLICIT_FILES[@]}"; do
  if [[ -f "${ROOT}/${f}" ]]; then
    mv "${ROOT}/${f}" "${ARCHIVE}/${f}"
    echo "  moved  ${f}"
  else
    echo "  skip   ${f} (not found)"
  fi
done

# ---- Pattern-based sweeps (root level only, not recursive) -----------
echo "==> Archiving pattern-matched files..."

# Python scripts in root
find "${ROOT}" -maxdepth 1 -name "*.py" | while read -r fp; do
  fname="$(basename "${fp}")"
  mv "${fp}" "${ARCHIVE}/${fname}"
  echo "  moved  ${fname}  [*.py]"
done

# test-*.txt / test_*.txt files in root
find "${ROOT}" -maxdepth 1 \( -name "test-*.txt" -o -name "test_*.txt" \) | while read -r fp; do
  fname="$(basename "${fp}")"
  mv "${fp}" "${ARCHIVE}/${fname}"
  echo "  moved  ${fname}  [test txt]"
done

# Screenshot PNG files in root
find "${ROOT}" -maxdepth 1 -name "*.png" | while read -r fp; do
  fname="$(basename "${fp}")"
  mv "${fp}" "${ARCHIVE}/${fname}"
  echo "  moved  ${fname}  [*.png]"
done

# temp_ JS/Python files in root
find "${ROOT}" -maxdepth 1 \( -name "temp_*.js" -o -name "temp_*.py" \) | while read -r fp; do
  fname="$(basename "${fp}")"
  mv "${fp}" "${ARCHIVE}/${fname}"
  echo "  moved  ${fname}  [temp_*]"
done

# inject-*.js files in root
find "${ROOT}" -maxdepth 1 -name "inject-*.js" | while read -r fp; do
  fname="$(basename "${fp}")"
  mv "${fp}" "${ARCHIVE}/${fname}"
  echo "  moved  ${fname}  [inject-*.js]"
done

# electron boot/debug test scripts
for f in electron-boot-test.cjs electron-debug.cjs; do
  if [[ -f "${ROOT}/${f}" ]]; then
    mv "${ROOT}/${f}" "${ARCHIVE}/${f}"
    echo "  moved  ${f}"
  fi
done

# hello.py already caught by *.py sweep above, but guard anyway
# twitter_*.py already caught by *.py sweep above

# Other one-off test TypeScript files that are not in src/
for f in test-brain.ts test-tools.ts; do
  if [[ -f "${ROOT}/${f}" ]]; then
    mv "${ROOT}/${f}" "${ARCHIVE}/${f}"
    echo "  moved  ${f}"
  fi
done

# Loose test text files not matching test-*.txt pattern
for f in test-hello.txt test-system.txt test-backend-output.txt test-write-tmp.txt test-screenshot.png; do
  if [[ -f "${ROOT}/${f}" ]]; then
    mv "${ROOT}/${f}" "${ARCHIVE}/${f}"
    echo "  moved  ${f}"
  fi
done

echo ""
echo "==> Done. Root directory now contains:"
ls "${ROOT}"
