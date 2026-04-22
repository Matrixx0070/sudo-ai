#!/bin/sh
# install-self-build-hooks.sh
# Points git at the committed .githooks/ directory and verifies hook permissions.
# Run once after cloning or before activating self-build mode.
set -eu

# ---------------------------------------------------------------------------
# 1. Verify we are inside a git repository
# ---------------------------------------------------------------------------
if ! git_dir=$(git rev-parse --git-dir 2>/dev/null); then
  echo "ERROR: not inside a git repository — cannot install hooks." >&2
  exit 1
fi
echo "Git directory: $git_dir"

# ---------------------------------------------------------------------------
# 2. Point git at the committed hooks directory
# ---------------------------------------------------------------------------
if git config core.hooksPath .githooks 2>/dev/null; then
  echo "Set core.hooksPath = .githooks (via git config)"
else
  # Fallback: write directly to .git/config (handles read-only tmpfs git dirs)
  cfg="$git_dir/config"
  if [ -w "$cfg" ]; then
    # Replace existing hooksPath or append under [core]
    if grep -q 'hooksPath' "$cfg"; then
      sed -i 's|hooksPath = .*|hooksPath = .githooks|' "$cfg"
    else
      sed -i '/^\[core\]/a\\thooksPath = .githooks' "$cfg"
    fi
    echo "Set core.hooksPath = .githooks (direct config edit)"
  else
    echo "WARNING: could not write git config — set core.hooksPath manually." >&2
    echo "  Run: git config core.hooksPath .githooks" >&2
  fi
fi

# ---------------------------------------------------------------------------
# 3. Verify hooks exist and are executable
# ---------------------------------------------------------------------------
HOOKS_DIR=".githooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "ERROR: .githooks directory not found at $(pwd)/.githooks" >&2
  exit 1
fi

errors=0
for hook in pre-commit pre-push; do
  hook_path="$HOOKS_DIR/$hook"
  if [ ! -f "$hook_path" ]; then
    echo "WARNING: hook not found: $hook_path" >&2
    errors=$((errors + 1))
    continue
  fi
  # Re-apply execute bit in case it was lost
  chmod +x "$hook_path"
  echo "Verified executable: $hook_path"
done

if [ "$errors" -gt 0 ]; then
  echo "WARNING: $errors hook(s) missing — self-build protection may be incomplete." >&2
fi

# ---------------------------------------------------------------------------
# 4. Confirm
# ---------------------------------------------------------------------------
echo ""
echo "Self-build git hooks installed successfully."
echo "  core.hooksPath = .githooks"
echo "  pre-commit: protects alignment stack + prevents test deletions"
echo "  pre-push:   blocks any push to refs/heads/main"
echo ""
echo "To bypass (human override only):"
echo "  SUDO_SELFBUILD_ALLOW_PROTECTED=1 git commit ..."
echo "  SUDO_SELFBUILD_ALLOW_MAIN_PUSH=1 git push ..."
