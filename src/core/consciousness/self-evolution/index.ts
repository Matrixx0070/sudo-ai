/**
 * @file index.ts
 * @description Barrel export for the self-evolution subsystem.
 *
 * Consumers import everything they need from this single entry point:
 *
 * ```ts
 * import {
 *   SelfEvolution,
 *   initializeDNA,
 *   detectFailurePatterns,
 *   type EvolutionProposal,
 *   type DigitalDNA,
 * } from '../self-evolution/index.js';
 * ```
 */

// Types
export type {
  EvolutionProposal,
  DigitalDNA,
  FailurePattern,
  EvoBrainLike,
  EvoSelfModelLike,
} from './types.js';

// Main class
export { SelfEvolution } from './evolver.js';

// Store helpers — proposals and failures
export {
  saveProposal,
  getProposals,
  updateProposalStatus,
  recordFailure,
  getUnresolvedFailures,
  resolveFailure,
} from './store.js';

// Store helpers — Digital DNA
export { getDNA, saveDNA } from './store-dna.js';

// Detector helpers
export { detectFailurePatterns, detectCapabilityGaps } from './detector.js';

// DNA helpers
export { initializeDNA, addGrowthEvent } from './dna.js';

// Soul writer
export { generateSoulUpdate } from './soul-writer.js';
