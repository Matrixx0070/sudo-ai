/**
 * @file index.ts
 * @description Barrel export for the SUDO-AI learning / wisdom subsystem.
 *
 * Usage:
 * ```ts
 * import { WisdomStore } from '../core/learning/index.js';
 * import type { Insight } from '../core/learning/index.js';
 * ```
 */

export { WisdomStore } from './store.js';
export type { Insight } from './types.js';

// Upgrade 66: Learning From Failures
export {
  recordFailure,
  recordSolution,
  getPreventionRule,
  hasSeenBefore,
  getSolution,
  getFailureStats,
} from './failure-learner.js';
export type { FailureRecord } from './failure-learner.js';
