/**
 * @file goal-pursuit.ts
 * @description Upgrade 70 — Proactive Goal Pursuit.
 *
 * Lets SUDO-AI set, track, and autonomously pursue goals with milestone-level
 * granularity.  Progress is recomputed automatically as milestones complete.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('autonomy:goals');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GoalPriority = 'low' | 'medium' | 'high' | 'critical';
export type GoalStatus   = 'active' | 'paused' | 'completed' | 'abandoned';

export interface GoalMilestone {
  id: number;
  description: string;
  completed: boolean;
  completedAt?: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  priority: GoalPriority;
  status: GoalStatus;
  progress: number; // 0-100
  milestones: GoalMilestone[];
  createdAt: string;
  deadline?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const goals: Map<string, Goal> = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recomputeProgress(goal: Goal): void {
  if (goal.milestones.length === 0) return;
  const done = goal.milestones.filter(m => m.completed).length;
  goal.progress = Math.round((done / goal.milestones.length) * 100);
  if (goal.progress === 100) goal.status = 'completed';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create and register a new goal.
 *
 * @param title       Short label shown in the UI.
 * @param description Detailed description of what success looks like.
 * @param priority    Scheduling priority.
 * @param deadline    Optional ISO-8601 deadline string.
 */
export function setGoal(
  title: string,
  description: string,
  priority: GoalPriority = 'medium',
  deadline?: string,
): Goal {
  if (!title)       throw new TypeError('title is required');
  if (!description) throw new TypeError('description is required');

  const goal: Goal = {
    id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    description,
    priority,
    status: 'active',
    progress: 0,
    milestones: [],
    createdAt: new Date().toISOString(),
    deadline,
  };

  goals.set(goal.id, goal);
  log.info({ id: goal.id, title, priority }, 'Goal set');
  return { ...goal, milestones: [] };
}

/**
 * Append a milestone to an existing goal.
 * Throws if the goal does not exist.
 */
export function addMilestone(goalId: string, description: string): GoalMilestone {
  if (!goalId)      throw new TypeError('goalId is required');
  if (!description) throw new TypeError('description is required');

  const g = goals.get(goalId);
  if (!g) throw new RangeError(`Goal not found: ${goalId}`);

  const milestone: GoalMilestone = {
    id: g.milestones.length + 1,
    description,
    completed: false,
  };
  g.milestones.push(milestone);
  log.debug({ goalId, milestoneId: milestone.id }, 'Milestone added');
  return { ...milestone };
}

/**
 * Mark a milestone as complete and recompute goal progress.
 * Automatically marks the goal as 'completed' when all milestones are done.
 */
export function completeMilestone(goalId: string, milestoneId: number): void {
  if (!goalId)                        throw new TypeError('goalId is required');
  if (typeof milestoneId !== 'number') throw new TypeError('milestoneId must be a number');

  const g = goals.get(goalId);
  if (!g) throw new RangeError(`Goal not found: ${goalId}`);

  const m = g.milestones.find(m => m.id === milestoneId);
  if (!m) throw new RangeError(`Milestone ${milestoneId} not found in goal ${goalId}`);

  m.completed   = true;
  m.completedAt = new Date().toISOString();
  recomputeProgress(g);

  log.info({ goalId, milestoneId, progress: g.progress, status: g.status }, 'Milestone completed');
}

/** All goals currently in 'active' status. */
export function getActiveGoals(): Goal[] {
  return Array.from(goals.values())
    .filter(g => g.status === 'active')
    .map(g => ({ ...g, milestones: g.milestones.map(m => ({ ...m })) }));
}

/** Retrieve a single goal by id (returns undefined if not found). */
export function getGoal(id: string): Goal | undefined {
  const g = goals.get(id);
  return g ? { ...g, milestones: g.milestones.map(m => ({ ...m })) } : undefined;
}

/** Pause an active goal without abandoning it. */
export function pauseGoal(id: string): void {
  const g = goals.get(id);
  if (!g) throw new RangeError(`Goal not found: ${id}`);
  g.status = 'paused';
  log.info({ id }, 'Goal paused');
}

/** Resume a paused goal. */
export function resumeGoal(id: string): void {
  const g = goals.get(id);
  if (!g) throw new RangeError(`Goal not found: ${id}`);
  g.status = 'active';
  log.info({ id }, 'Goal resumed');
}

/** All registered goals regardless of status. */
export function listGoals(): Goal[] {
  return Array.from(goals.values()).map(g => ({ ...g, milestones: g.milestones.map(m => ({ ...m })) }));
}
