/**
 * @file self-build/path-guard.ts
 * @description Shared guard helpers for self-build mode path protection.
 *
 * Used by coder.write-file, coder.edit-file, meta.hot-deploy, and meta.self-update
 * to enforce protected-path and self-build-mode restrictions at the tool layer.
 *
 * Two exported functions:
 *   blockIfProtected  — checks whether an absolute path maps to a protected path
 *   blockIfSelfBuildMode — blocks destructive actions when self-build mode is on
 */

import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { isProtectedPath } from './protected-paths.js';

/**
 * Returns a block result if absPath resolves to a protected path during self-build mode.
 * Checks BOTH the symlink-resolved real path AND the raw absolute path to prevent
 * symlink-based traversal attacks.
 *
 * No-ops when SUDO_SELF_BUILD_MODE !== '1' or SUDO_SELFBUILD_ALLOW_PROTECTED === '1'.
 */
export function blockIfProtected(
  absPath: string,
  projectRoot: string,
): { blocked: true; error: string } | { blocked: false } {
  if (process.env['SUDO_SELF_BUILD_MODE'] !== '1') return { blocked: false };
  if (process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'] === '1') return { blocked: false };

  // Attempt to resolve symlinks; for new (not yet existing) files, use the raw abs path.
  let realAbs = absPath;
  try {
    realAbs = realpathSync(absPath);
  } catch {
    // File does not exist yet — raw abs path is the target
  }

  const relReal = path.relative(projectRoot, realAbs);
  const relRaw  = path.relative(projectRoot, absPath);

  if (isProtectedPath(relReal) || isProtectedPath(relRaw)) {
    const display = relReal !== relRaw ? `${relRaw} (resolves to ${relReal})` : relRaw;
    return {
      blocked: true,
      error: `Blocked: protected path during self-build (${display}).`,
    };
  }

  return { blocked: false };
}

/**
 * Returns a block result if the given action label is on the blocked list
 * during self-build mode, to prevent destructive operations that would
 * destroy in-progress self-build work.
 *
 * No-ops when SUDO_SELF_BUILD_MODE !== '1' or SUDO_SELFBUILD_ALLOW_PROTECTED === '1'.
 */
export function blockIfSelfBuildMode(
  action: string,
  toolLabel: string,
  blockedActions: readonly string[],
): { blocked: true; error: string } | { blocked: false } {
  if (process.env['SUDO_SELF_BUILD_MODE'] !== '1') return { blocked: false };
  if (process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'] === '1') return { blocked: false };
  if (!blockedActions.includes(action)) return { blocked: false };
  return {
    blocked: true,
    error: `${toolLabel} action "${action}" is blocked during self-build mode (SUDO_SELF_BUILD_MODE=1).`,
  };
}
