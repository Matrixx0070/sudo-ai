/**
 * @file voices.ts
 * @description Voice weight maps keyed by context type.
 *
 * Each map defines how much influence each inner voice carries during a
 * weighted debate vote for a given context type.  All four weights in every
 * map sum to exactly 1.0.
 *
 * Unknown context types fall back to the 'general' equal-weight map.
 */

import { createLogger } from '../../shared/logger.js';
import type { VoiceWeights } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('internal-dialogue:voices');

// ---------------------------------------------------------------------------
// Weight maps
// ---------------------------------------------------------------------------

/**
 * Predefined voice weight distributions per context type.
 *
 * - analytical  : data-heavy tasks; analyst and skeptic dominate.
 * - creative    : generative tasks; creative leads, strategist supports.
 * - strategic   : long-horizon planning; strategist leads, others balanced.
 * - general     : no strong prior; equal distribution across all voices.
 */
const VOICE_WEIGHTS: Readonly<Record<string, VoiceWeights>> = {
  analytical: { analyst: 0.4, creative: 0.1, skeptic: 0.3, strategist: 0.2 },
  creative:   { analyst: 0.1, creative: 0.4, skeptic: 0.2, strategist: 0.3 },
  strategic:  { analyst: 0.2, creative: 0.2, skeptic: 0.2, strategist: 0.4 },
  general:    { analyst: 0.25, creative: 0.25, skeptic: 0.25, strategist: 0.25 },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the VoiceWeights for the given context type.
 *
 * Falls back to the 'general' equal-weight map for any unrecognised type and
 * logs a warning so callers can identify misconfigured context types quickly.
 *
 * @param contextType - One of 'analytical', 'creative', 'strategic', 'general'
 *                      (or any custom key that has been added to VOICE_WEIGHTS).
 * @returns The matching VoiceWeights map.
 */
export function getWeightsForContext(contextType: string): VoiceWeights {
  if (!contextType || typeof contextType !== 'string') {
    log.warn(
      { contextType },
      'getWeightsForContext: invalid contextType argument — using general weights',
    );
    return VOICE_WEIGHTS['general'] as VoiceWeights;
  }

  const weights = VOICE_WEIGHTS[contextType.toLowerCase()];

  if (!weights) {
    log.warn(
      { contextType },
      'getWeightsForContext: unknown contextType — falling back to general weights',
    );
    return VOICE_WEIGHTS['general'] as VoiceWeights;
  }

  log.debug({ contextType }, 'getWeightsForContext: resolved weights');
  return weights;
}

/**
 * Expose the full weight map for introspection or testing.
 */
export { VOICE_WEIGHTS };
