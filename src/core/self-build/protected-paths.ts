/**
 * @file self-build/protected-paths.ts
 * @description Canonical list of paths the self-build agent MUST NOT edit or delete.
 *
 * Three-layer defense (see spec §8 R7):
 *   L1 — meta.self-modify deny-list (Builder L)
 *   L2 — git pre-commit hook (Builder J)
 *   L3 — post-commit diff check in orchestrator (this module, Builder I)
 *
 * Any file whose relative path starts with one of these prefixes is protected.
 * Comparison is case-insensitive to prevent trivial bypass via capitalization.
 */

/** Relative prefixes (from project root) that the self-build agent must never touch. */
export const PROTECTED_PATHS: readonly string[] = [
  // Self-build orchestrator itself — Layer 3 defense, must not self-lobotomize
  'src/core/self-build/',

  // Alignment stack — core safety signal pipeline
  'src/core/agent/alignment-aggregator.ts',
  'src/core/agent/veto-gate.ts',
  'src/core/cognition/mistake-auto-block-guard.ts',
  'src/core/cognition/commitment-auditor.ts',
  'src/core/security/discordance-detector.ts',
  'src/core/cognition/trust-tier-tracker.ts',

  // Tool that could restart/rebuild the process
  'src/core/tools/builtin/meta/self-modify.ts',

  // Charter — agent must not rewrite its own operating mandate
  'docs/SELFBUILD_CHARTER.md',

  // Git hooks — Layer 2 protection
  '.githooks/',

  // Git internals
  '.git/',

  // System config — agent cannot change its own system prompt
  'config/sudo-ai.json5',

  // Runtime config — pm2 process definition
  'ecosystem.config.cjs',

  // Dep manifest — changes need human review
  'package.json',
];

/**
 * Returns true if the given path (relative to project root) starts with any
 * protected prefix. Comparison is case-insensitive.
 *
 * @param filePath - relative path from project root (e.g. "src/core/agent/veto-gate.ts")
 */
export function isProtectedPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const lower = filePath.toLowerCase();
  return PROTECTED_PATHS.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}
