/**
 * @file index.ts
 * @description Barrel export for the relationship-model subsystem.
 *
 * External consumers should import exclusively from this file:
 *
 *   import { RelationshipTracker, type Relationship }
 *     from './relationship-model/index.js';
 */

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export { RelationshipTracker } from './tracker.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { Relationship, RelEpisodeLike, ToMLike } from './types.js';

// ---------------------------------------------------------------------------
// Store utilities (exported for direct use in tests / admin tooling)
// ---------------------------------------------------------------------------

export {
  saveRelationship,
  getRelationship,
  getAllRelationships,
} from './store.js';
