/**
 * @file index.ts
 * @description Public surface of the autonomy module.
 *
 * Consumers import from 'src/core/autonomy' to get the event loop
 * and its supporting types.
 */

export {
  AutonomousEventLoop,
} from './event-loop.js';

export type {
  Plan,
  PlanStep,
  EventLoopState,
} from './event-loop.js';

// Upgrade 70: Proactive Goal Pursuit
// F91: legacy goal-pursuit (superseded by goal-engine-v2) and the unused
// autonomous-executor were removed; approval-matrix stays (computer-use
// approval seam reference implementation).
export type { ApprovalTier, ApprovalRule, ApprovalDecision } from './approval-matrix.js';
