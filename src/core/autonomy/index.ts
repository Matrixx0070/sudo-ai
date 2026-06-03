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
export {
  setGoal,
  addMilestone,
  completeMilestone,
  getActiveGoals,
  getGoal,
  pauseGoal,
  resumeGoal,
  listGoals,
} from './goal-pursuit.js';
export type { Goal, GoalMilestone, GoalPriority, GoalStatus } from './goal-pursuit.js';

// P1 cross-platform control wiring (approval + executor for IComputerUse)
export {
  type ControlAction,
} from './autonomous-executor.js';
export type { ApprovalTier, ApprovalRule, ApprovalDecision } from './approval-matrix.js';
