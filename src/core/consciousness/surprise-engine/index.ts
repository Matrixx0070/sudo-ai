/**
 * @file index.ts
 * @description Barrel export for the surprise-engine module.
 *
 * Consumers should import exclusively from this entry point:
 *   import { SurpriseEngine, type SurpriseEvent } from '.../surprise-engine/index.js'
 */

export type {
  EmotionalStateLike,
  SurpriseEvent,
  WorldModelLike,
} from './types.js';

export {
  getAverageSurprise,
  getRecentSurprises,
  saveSurpriseEvent,
} from './store.js';

export { SurpriseEngine } from './engine.js';
