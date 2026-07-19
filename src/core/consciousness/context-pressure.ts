/**
 * @file context-pressure.ts
 * @description CW2 — real context pressure for consciousness injection.
 *
 * The loop already computes prompt occupancy proactively (gw-refactor P2:
 * estimateContextSize / getAliasLimits / decideContextBudget). This module
 * turns that occupancy into a detail tier + token budget for the LIVE
 * consciousness injection path (the intelligence brief and the deep bridge),
 * replacing nothing until the caller opts in (SUDO_CAS_PRESSURE=1 in loop.ts).
 *
 * Tier thresholds are harvested from the (unattached) ConsciousnessBridge
 * (context-bridge.ts resolveDetailTier: full <50%, compressed >85%), collapsed
 * to three tiers per the CW2 design recorded in docs/CAS_WIRING_STATUS.md.
 * capToBudget is the bridge's code-point-safe truncation as a shared util —
 * CW3 harvests/deletes the bridge against this.
 *
 * Zero LLM calls; pure functions; deterministic.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('consciousness:context-pressure');

export type PressureTier = 'full' | 'compressed' | 'minimal';

/** ~4 chars per token — same estimator convention as the bridge/brief. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

/**
 * Map context-window occupancy (0..1) to an injection detail tier.
 *  - full:       < 0.50 — inject unmodified
 *  - compressed: 0.50–0.85 — cap the injected block
 *  - minimal:    > 0.85 — cap hard
 * Out-of-range/NaN occupancy clamps into [0,1] (fail-open toward 'full' at 0).
 */
export function pressureTier(occupancy: number): PressureTier {
  const occ = Number.isFinite(occupancy) ? Math.max(0, Math.min(1, occupancy)) : 0;
  if (occ > 0.85) return 'minimal';
  if (occ >= 0.5) return 'compressed';
  return 'full';
}

/**
 * Token budget for the injected consciousness block at a tier.
 * `undefined` = no cap (tier 'full'). Budgets follow the bridge's scale
 * (~600 tokens at its concise tier).
 */
export function budgetForTier(tier: PressureTier): number | undefined {
  switch (tier) {
    case 'full': return undefined;
    case 'compressed': return 600;
    case 'minimal': return 150;
  }
}

/**
 * Cap `text` to `maxTokens`, truncating at a word boundary with a marker.
 * Code-point-safe (never splits surrogate pairs). Deterministic. The returned
 * string's estimated tokens never exceed maxTokens (the marker's cost is
 * reserved before slicing).
 */
export function capToBudget(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;

  const suffix = '… [truncated: context pressure]';
  const budgetChars = Math.max(0, (maxTokens - estimateTokens(suffix)) * 4);
  if (text.length <= budgetChars) return text;

  // Walk CODE POINTS (never splitting surrogate pairs) while budgeting in
  // UTF-16 units — astral code points cost 2 units, so a naive
  // Array.from().slice(0, budgetChars) could return up to 2x the budget
  // (a latent bug in the bridge original this replaces).
  let truncated = '';
  for (const cp of text) {
    if (truncated.length + cp.length > budgetChars) break;
    truncated += cp;
  }
  const lastSpace = truncated.lastIndexOf(' ');
  const cut = lastSpace > budgetChars * 0.5 ? truncated.slice(0, lastSpace) : truncated;

  log.debug({ originalTokens: estimateTokens(text), maxTokens }, 'CW2: consciousness block capped');
  return `${cut}${suffix}`;
}
