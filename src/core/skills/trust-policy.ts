/**
 * @file trust-policy.ts
 * @description Capability intersection enforcement for skill trust tiers.
 *
 * Provides a pure function to check whether a skill's declared capabilities
 * are permitted by its trust tier policy. Uses DEFAULT_TIER_CAPS from the
 * shared Wave 10 types contract.
 *
 * Trust hierarchy (most to least trusted):
 *   bundled    — full caps: fs.read, fs.write, net.fetch, db.read, db.write, shell.exec, skill.load
 *   indexed    — vetted caps: fs.read, net.fetch, db.read
 *   unreviewed — minimal caps: fs.read only
 *   workspace  — user-override caps: fs.read, fs.write, net.fetch, db.read
 */

import type {
  Capability,
  CapabilityCheckResult,
  SkillTrustTier,
} from '../shared/wave10-types.js';
import { DEFAULT_TIER_CAPS } from '../shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether all `required` capabilities are allowed under the given
 * trust `tier` policy.
 *
 * @param required - Capabilities the skill declares it needs.
 * @param tier     - Trust tier assigned at import/register time.
 * @returns CapabilityCheckResult with granted flag and list of missing caps.
 */
export function checkCapabilities(
  required: Capability[],
  tier: SkillTrustTier,
): CapabilityCheckResult {
  const allowed = new Set<string>(DEFAULT_TIER_CAPS[tier]);
  const missing = required.filter((cap) => !allowed.has(cap));
  return {
    granted: missing.length === 0,
    missing,
  };
}

/**
 * Intersect a set of claimed capabilities with the tier policy, returning
 * only the caps that are actually permitted.
 *
 * Used at load time to clamp what a skill can claim.
 *
 * @param claimed - Capability strings from the skill manifest.
 * @param tier    - Trust tier for the policy lookup.
 * @returns Filtered capability array containing only permitted caps.
 */
export function intersectCapabilities(
  claimed: Capability[],
  tier: SkillTrustTier,
): Capability[] {
  const allowed = new Set<string>(DEFAULT_TIER_CAPS[tier]);
  return claimed.filter((cap) => allowed.has(cap));
}

/**
 * Return the full set of capabilities permitted for a given trust tier.
 * Useful for documentation and capability negotiation.
 */
export function tierCaps(tier: SkillTrustTier): Capability[] {
  return [...DEFAULT_TIER_CAPS[tier]];
}
