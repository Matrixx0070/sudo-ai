/**
 * @file index.ts
 * @description Barrel export for the self-model subsystem.
 *
 * External consumers should import exclusively from this file:
 *
 *   import { SelfModel, type EpisodeLike, type SelfSummary } from
 *     './self-model/index.js';
 */

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export { SelfModel } from './model.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  PersonalityTrait,
  SelfSummary,
  EpisodeLike,
  CapabilityAssessment,
} from './types.js';

// ---------------------------------------------------------------------------
// Store utilities (exported for direct use in tests / admin tooling)
// ---------------------------------------------------------------------------

export {
  upsertCapability,
  getCapabilities,
  getByLevel,
  getByTrend,
  savePersonalityObservation,
  getPersonalityTraits,
} from './store.js';

// ---------------------------------------------------------------------------
// Assessor utilities (exported for unit-testing pure logic)
// ---------------------------------------------------------------------------

export {
  assessFromEpisode,
  computePersonalityFromHistory,
} from './assessor.js';
