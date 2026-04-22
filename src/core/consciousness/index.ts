/**
 * @file index.ts
 * @description Barrel export for the SUDO-AI v4 consciousness layer (Wave 1).
 *
 * Consumers import everything they need from this single entry point:
 *
 * ```ts
 * import {
 *   ConsciousnessDB,
 *   ConsciousnessError,
 *   type BodyState,
 *   type Thought,
 *   type EmotionTag,
 * } from '../consciousness/index.js';
 * ```
 */

// Errors
export { ConsciousnessError } from './errors.js';

// Database wrapper
export { ConsciousnessDB } from './consciousness-db.js';

// All shared types
export type {
  BodyState,
  EmotionTag,
  EmotionalValence,
  Thought,
  ThoughtTier,
  DriveState,
  Prediction,
  UserModel,
  RelationshipStage,
  AttentionSignal,
  CapabilityAssessment,
  VoiceName,
  VoicePosition,
  ConsolidationResult,
} from './types.js';
