/**
 * @file index.ts
 * @description Public barrel for the world-model sub-module.
 *
 * Consumers import everything they need from this single entry point:
 *
 * ```ts
 * import { WorldModel, type WorldModelEntry, makePrediction } from '../world-model/index.js';
 * ```
 */

// Class facade
export { WorldModel } from './model.js';

// Types
export type { WorldModelEntry } from './types.js';
export type { OutcomeResult } from './tracker.js';

// Store helpers (for consumers that need low-level access)
export {
  savePrediction,
  getPredictions,
  getPending,
  getById,
  updateOutcome,
  expireOld,
  getConfidenceForDomain,
} from './store.js';

// Predictor factory
export { makePrediction } from './predictor.js';

// Tracker
export { recordOutcome } from './tracker.js';
