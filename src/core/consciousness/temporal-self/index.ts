/**
 * @file index.ts
 * @description Barrel export for the temporal-self subsystem.
 *
 * External consumers should import exclusively from this file:
 *
 *   import { TemporalSelf, type SelfSnapshot, type Aspiration }
 *     from './temporal-self/index.js';
 */

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export { TemporalSelf } from './timeline.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { SelfSnapshot, Aspiration, SelfModelLike } from './types.js';

// ---------------------------------------------------------------------------
// Store utilities (exported for direct use in tests / admin tooling)
// ---------------------------------------------------------------------------

export {
  saveSnapshot,
  getTimeline,
  saveAspiration,
  getAspirations,
  updateAspirationStatus,
} from './store.js';
