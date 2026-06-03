/**
 * @file kanban-types.ts
 * @description Type definitions for Kanban board and swarm orchestration.
 */

// ---------------------------------------------------------------------------
// Kanban Task
// ---------------------------------------------------------------------------

/** Workspace scope for task isolation. */
export type KanbanWorkspace = 'scratch' | 'project' | 'session';

/** Task status in the kanban flow. */
export type KanbanStatus = 'todo' | 'in_progress' | 'review' | 'done';

/** Priority level 1-5 (5 = highest). */
export type KanbanPriority = 1 | 2 | 3 | 4 | 5;

/**
 * A task on the kanban board.
 */
export interface KanbanTask {
  /** Unique task ID (UUID). */
  id: string;
  /** Short title summarizing the task. */
  title: string;
  /** Detailed description/body of the task. */
  body: string;
  /** Current status in workflow. */
  status: KanbanStatus;
  /** Priority 1-5 (5 = highest). */
  priority: KanbanPriority;
  /** Optional assignee (agent ID or human). */
  assignee?: string | null;
  /** Skills required to complete this task. */
  skills: string[];
  /** Optional parent task ID for subtasks. */
  parentId?: string | null;
  /** Workspace isolation scope. */
  workspace: KanbanWorkspace;
  /** Optional tenant ID for multi-tenant isolation. */
  tenantId?: string | null;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Swarm Worker Specification
// ---------------------------------------------------------------------------

/**
 * Specification for spawning a swarm worker agent.
 */
export interface SwarmWorkerSpec {
  /** Agent model/profile to use (e.g., 'sonnet', 'opus'). */
  profile: string;
  /** Short title for the worker's subtask. */
  title: string;
  /** Detailed instructions for the worker. */
  body: string;
  /** Skills this worker should use. */
  skills: string[];
  /** Priority 1-5 inherited from parent task. */
  priority: KanbanPriority;
  /** Optional max runtime in seconds (default: 300). */
  maxRuntimeSeconds?: number;
}

// ---------------------------------------------------------------------------
// Swarm Result Tracking
// ---------------------------------------------------------------------------

/** Status of a swarm execution. */
export type SwarmStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Tracks the state of a spawned swarm.
 */
export interface SwarmResult {
  /** Root task ID that spawned this swarm. */
  rootId: string;
  /** Unique swarm execution ID. */
  swarmId: string;
  /** IDs of worker agents spawned. */
  workerIds: string[];
  /** ID of verifier agent (if run). */
  verifierId?: string | null;
  /** ID of synthesizer agent (if run). */
  synthesizerId?: string | null;
  /** Current execution status. */
  status: SwarmStatus;
  /** Map of worker ID -> result string. */
  results: Map<string, string>;
  /** Error message if failed. */
  error?: string | null;
  /** ISO 8601 timestamp when swarm started. */
  startedAt: string;
  /** ISO 8601 timestamp when swarm completed/failed. */
  completedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Task Transition
// ---------------------------------------------------------------------------

/** Valid status transitions. */
export const STATUS_TRANSITIONS: Record<KanbanStatus, KanbanStatus[]> = {
  todo: ['in_progress', 'done'],
  in_progress: ['review', 'done', 'todo'],
  review: ['done', 'in_progress', 'todo'],
  done: ['todo', 'in_progress'],
};

/**
 * Check if a status transition is valid.
 */
export function isValidTransition(from: KanbanStatus, to: KanbanStatus): boolean {
  return STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
