/**
 * @file index.ts
 * @description Barrel export for the sleep-cycle subsystem of SUDO-AI v4.
 *
 * Consumers should import exclusively from this file:
 *
 * ```ts
 * import {
 *   SleepCycle,
 *   type SleepSession,
 *   type SleepBrainLike,
 *   type SleepEpisodicLike,
 * } from '../sleep-cycle/index.js';
 * ```
 */

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export { SleepCycle } from './consolidator.js';

// ---------------------------------------------------------------------------
// Types and duck-typed interfaces
// ---------------------------------------------------------------------------

export type {
  SleepSession,
  SleepBrainLike,
  SleepEpisodicLike,
  SleepCounterfactualLike,
  SleepSelfModelLike,
  SleepTemporalSelfLike,
  SleepMetacognitionLike,
  SleepWisdomLike,
} from './types.js';

// ---------------------------------------------------------------------------
// Store utilities (for testing and admin tooling)
// ---------------------------------------------------------------------------

export {
  saveSleepSession,
  getRecentSessions,
  getDreamJournal,
} from './store.js';

// ---------------------------------------------------------------------------
// Dream generator (exported for direct use in tests)
// ---------------------------------------------------------------------------

export { generateDream } from './dream-generator.js';
