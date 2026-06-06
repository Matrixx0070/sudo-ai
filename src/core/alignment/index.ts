/**
 * @file index.ts
 * @description Barrel export for the SUDO-AI v4 alignment engine (Phase 3).
 *
 * Consumers import everything they need from this single entry point:
 *
 * ```ts
 * import {
 *   AlignmentEngine,
 *   type AlignmentScore,
 *   type AlignmentSignal,
 *   type AlignmentLevel,
 * } from '../alignment/index.js';
 * ```
 */

export { AlignmentEngine } from './alignment-engine.js';
export type { AlignmentScore, AlignmentSignal, AlignmentLevel } from './alignment-engine.js';