/**
 * @file superpowers/gating.ts
 * @description F108 (docs/CORE_ROADMAP.md Wave D) — per-tool gating for the
 * superpower toolkit.
 *
 * Before F108 every superpower tool (deploy, security-scan, ffmpeg, scraper,
 * api-builder, …) registered unconditionally — an ungoverned privilege surface.
 * This adds an allowlist/denylist config plus a fail-closed default for unknown
 * tools:
 *
 *   - SUDO_SUPERPOWERS_ALLOW="super.deploy,super.ffmpeg"  → ONLY those register
 *     (strict allowlist mode; everything else is denied).
 *   - SUDO_SUPERPOWERS_DENY="super.deploy"                → those are excluded
 *     (denylist mode over the known set).
 *   - neither set                                         → all KNOWN tools
 *     register (default behaviour preserved).
 *
 * Fail-closed for unknown/new tools: outside strict allowlist mode, a tool whose
 * name is NOT in {@link KNOWN_SUPERPOWER_TOOLS} is denied by default. A newly
 * added superpower must be added to the known registry (or explicitly
 * allowlisted) before it can gain privilege — it never silently registers.
 */

/** Canonical set of vetted superpower tool names. Keep in sync when adding one. */
export const KNOWN_SUPERPOWER_TOOLS: readonly string[] = [
  'super.auto-fix',
  'super.deploy',
  'super.security-scan',
  'super.profile',
  'super.analyze-data',
  'super.build-api',
  'super.build-scraper',
  'super.generate-pdf',
  'super.edit-image',
  'super.ffmpeg',
  'super.archive',
  'super.translate',
];

/** Minimal shape the gate needs from a tool definition. */
export interface NamedTool {
  name: string;
}

function parseList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export interface GateDecision<T extends NamedTool> {
  /** Tools that passed the gate and should be registered. */
  enabled: T[];
  /** Tool names that were withheld, with a reason (for logging). */
  denied: Array<{ name: string; reason: string }>;
  /** True when a strict allowlist is in force. */
  allowlistMode: boolean;
}

/**
 * Decide which superpower tools may register given the env config.
 * Pure — no side effects. Fail-closed for unknown tools outside allowlist mode.
 */
export function gateSuperpowers<T extends NamedTool>(
  tools: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
): GateDecision<T> {
  const allow = parseList(env['SUDO_SUPERPOWERS_ALLOW']);
  const deny = parseList(env['SUDO_SUPERPOWERS_DENY']);
  const known = new Set(KNOWN_SUPERPOWER_TOOLS);
  const allowlistMode = allow.size > 0;

  const enabled: T[] = [];
  const denied: Array<{ name: string; reason: string }> = [];

  for (const tool of tools) {
    if (allowlistMode) {
      if (allow.has(tool.name)) enabled.push(tool);
      else denied.push({ name: tool.name, reason: 'not in SUDO_SUPERPOWERS_ALLOW' });
      continue;
    }
    if (deny.has(tool.name)) {
      denied.push({ name: tool.name, reason: 'in SUDO_SUPERPOWERS_DENY' });
      continue;
    }
    if (!known.has(tool.name)) {
      // Fail-closed: unknown/new tool must be vetted (added to the known set)
      // or explicitly allowlisted before it can register.
      denied.push({ name: tool.name, reason: 'unknown superpower — fail-closed (add to KNOWN_SUPERPOWER_TOOLS or allowlist)' });
      continue;
    }
    enabled.push(tool);
  }

  return { enabled, denied, allowlistMode };
}
