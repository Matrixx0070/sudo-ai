/**
 * @file index.ts
 * @description Public barrel for the cognitive-stream module.
 */

export { CognitiveStream } from './stream.js';
export type {
  ThoughtConfig,
  StreamState,
  InterruptResult,
  StreamBrainLike,
  StreamThought,
  BodyStateLike,
  SpreadingActivationLike,
  EmotionalStateLike,
} from './types.js';
export {
  saveThought,
  getRecentThoughts,
  getThoughtsByTier,
  pruneOldThoughts,
} from './store.js';
