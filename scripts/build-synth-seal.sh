#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../src/core/tools/builtin/meta/synth-seccomp-seal.c"
OUT="$SCRIPT_DIR/../bin/synth-seccomp-seal.so"
if [[ "$(uname -s)" != "Linux" ]] || [[ "$(uname -m)" != "x86_64" ]]; then
  echo "[build-synth-seal] Skipping: not Linux x86_64 ($(uname -s)/$(uname -m))" >&2
  exit 0
fi
mkdir -p "$(dirname "$OUT")"
gcc -shared -fPIC -O2 -Wall -Wextra -o "$OUT" "$SRC"
echo "[build-synth-seal] Built: $OUT"
