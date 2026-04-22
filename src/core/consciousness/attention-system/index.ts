/**
 * @file index.ts
 * @description Public barrel for the attention-system sub-module.
 *
 * Consumers should import exclusively from this file so that internal
 * reorganisation never breaks callsites outside this directory.
 */

// Local types
export type { CognitiveBudget } from './types.js';

// Budget utilities
export { calculateBudget, allocateThoughtTier } from './budget.js';

// Attention manager
export { AttentionManager } from './attention.js';

// Re-export parent types used in this module's public API so callers can get
// everything they need from a single import path.
export type { AttentionSignal, ThoughtTier, BodyState } from '../types.js';
