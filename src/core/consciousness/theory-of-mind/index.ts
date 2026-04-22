/**
 * @file index.ts
 * @description Public barrel for the theory-of-mind subsystem.
 *
 * Consumers import the TheoryOfMind class and supporting types from this
 * single entry point, keeping internal module boundaries opaque.
 */

export { TheoryOfMind } from './user-modeler.js';

export type {
  InteractionRecord,
  MindReaderBrainLike,
  UserPrediction,
} from './types.js';
