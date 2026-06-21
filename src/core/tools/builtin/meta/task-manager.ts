/**
 * meta.task-manager — SUDO-AI's own task queue management tool.
 *
 * Allows the brain to enqueue work, monitor the queue, cancel tasks,
 * view stats, and retry failed tasks — all via the tool interface.
 *
 * Actions:
 *   enqueue      — add a new task with priority, payload, and optional deps
 *   list         — list tasks (filterable by status / priority)
 *   cancel       — cancel a specific task by ID
 *   stats        — queue health summary (counts, avgDuration)
 *   retry-failed — re-queue all failed tasks that still have retries left
 *   get          — fetch a single task by ID (full UUID or unique short prefix)
 *   prune        — delete terminal (completed/cancelled/failed) tasks by age
 */

import path from 'node:path';
import { TaskQueue, type EnqueueInput, type TaskPriority, type Task } from '../../../orchestration/task-queue.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { MIND_DB } from '../../../shared/paths.js';

const logger = createLogger('meta-task-manager');

const DB_PATH = MIND_DB;

// ---------------------------------------------------------------------------
// Lazy singleton queue — opens once per process lifetime.
//
// IMPORTANT: this is a READ-ONLY management view of the TaskQueue. It does NOT
// register any handler with a TaskExecutor (it does not start one). The actual
// executor lives in src/core/workflows/queue.ts behind SUDO_WORKFLOWS_QUEUE=1
// and dispatches the `workflow.run` task type. The two connections share the
// same mind.db (better-sqlite3 supports concurrent connections under WAL).
//
// Do not start a TaskExecutor here without coordinating with WorkflowQueue —
// the two would race on dequeue() because each enforces its own maxConcurrent
// cap (this one 8; queue.ts 2 by default) against the same `running` rows.
// Cross-process / cross-executor scheduling is a future-slice concern.
// ---------------------------------------------------------------------------

let _queue: TaskQueue | null = null;

function getQueue(): TaskQueue {
  if (!_queue) {
    _queue = new TaskQueue(DB_PATH, 8);
  }
  return _queue;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_PRIORITIES = new Set<string>(['critical', 'high', 'normal', 'low', 'background']);
const VALID_STATUSES = new Set<string>(['queued', 'running', 'completed', 'failed', 'blocked', 'cancelled']);

function validatePriority(p: unknown): p is TaskPriority {
  return typeof p === 'string' && VALID_PRIORITIES.has(p);
}

/**
 * Resolve a task from a full id or the short id prefix shown by `list`
 * (`id.slice(0, 8)`). Without this, copying the visible 8-char id into get/cancel
 * fails an exact-UUID lookup with "Task not found".
 */
function resolveTaskId(queue: TaskQueue, raw: string): { task?: Task; error?: string } {
  const matches = queue.findByIdPrefix(raw);
  if (matches.length === 0) return { error: `Task not found: ${raw}` };
  if (matches.length > 1) {
    const ids = matches.map(t => t.id.slice(0, 8)).join(', ');
    return { error: `Ambiguous task id "${raw}" matches ${matches.length} tasks (${ids}). Use more characters.` };
  }
  return { task: matches[0] };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const taskManagerTool: ToolDefinition = {
  name: 'meta.task-manager',
  description:
    'Manage SUDO-AI\'s internal task queue. Enqueue work items with priorities and dependencies, monitor queue health, cancel or retry tasks. Use this when you need to schedule multi-step work, track long-running operations, or orchestrate parallel jobs.',
  category: 'meta',
  timeout: 15_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['enqueue', 'list', 'get', 'cancel', 'stats', 'retry-failed', 'prune'],
    },

    // enqueue params
    name: {
      type: 'string',
      description: '[enqueue] Task name / type identifier (e.g. "pipeline.render-video"). Used to resolve the handler.',
    },
    taskDescription: {
      type: 'string',
      description: '[enqueue] Human-readable description of what this task does.',
    },
    priority: {
      type: 'string',
      description: '[enqueue] Execution priority.',
      enum: ['critical', 'high', 'normal', 'low', 'background'],
      default: 'normal',
    },
    payload: {
      type: 'object',
      description: '[enqueue] Task-specific data passed to the handler at runtime.',
      properties: {},
    },
    dependsOn: {
      type: 'array',
      description: '[enqueue] Array of task IDs that must complete before this task runs.',
      items: { type: 'string', description: 'Task ID' },
    },
    maxRetries: {
      type: 'number',
      description: '[enqueue] Maximum retry attempts on failure (default: 3).',
      default: 3,
    },
    timeoutMs: {
      type: 'number',
      description: '[enqueue] Per-execution timeout in milliseconds (default: 120000).',
      default: 120000,
    },
    createdBy: {
      type: 'string',
      description: '[enqueue] Who is creating this task: "user", "system", "cron", "self".',
      default: 'self',
    },

    // list params
    filterStatus: {
      type: 'string',
      description: '[list] Filter by status.',
      enum: ['queued', 'running', 'completed', 'failed', 'blocked', 'cancelled'],
    },
    filterPriority: {
      type: 'string',
      description: '[list] Filter by priority level.',
      enum: ['critical', 'high', 'normal', 'low', 'background'],
    },
    limit: {
      type: 'number',
      description: '[list] Maximum number of tasks to return (default: 20).',
      default: 20,
    },

    // get / cancel params
    taskId: {
      type: 'string',
      description: '[get, cancel] The task id to operate on. Accepts the full UUID or the short '
        + 'id prefix shown by `list` (as long as the prefix is unambiguous).',
    },

    // prune params
    olderThanDays: {
      type: 'number',
      description: '[prune] Delete terminal tasks (completed/cancelled/failed) finished more than '
        + 'this many days ago (default: 7). Use 0 to clear all terminal tasks regardless of age.',
      default: 7,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.task-manager invoked');

    try {
      const queue = getQueue();

      switch (action) {

        // -------------------------------------------------------------------
        case 'enqueue': {
          const name = (params['name'] as string | undefined)?.trim();
          if (!name) return { success: false, output: 'name is required for enqueue.' };

          const rawPriority = (params['priority'] as string | undefined) ?? 'normal';
          if (!validatePriority(rawPriority)) {
            return { success: false, output: `Invalid priority "${rawPriority}". Must be one of: ${[...VALID_PRIORITIES].join(', ')}` };
          }

          const rawMaxRetries = params['maxRetries'] as number | undefined;
          const maxRetries = rawMaxRetries !== undefined
            ? Math.min(10, Math.max(0, Math.floor(rawMaxRetries)))
            : 3;

          const rawTimeout = params['timeoutMs'] as number | undefined;
          const timeoutMs = rawTimeout !== undefined
            ? Math.min(3_600_000, Math.max(1_000, Math.floor(rawTimeout)))
            : 120_000;

          const dependsOn = Array.isArray(params['dependsOn'])
            ? (params['dependsOn'] as unknown[]).filter(v => typeof v === 'string') as string[]
            : [];

          const input: EnqueueInput = {
            name,
            description: (params['taskDescription'] as string | undefined) ?? '',
            priority:    rawPriority,
            dependsOn,
            payload:     params['payload'] ?? {},
            maxRetries,
            timeoutMs,
            createdBy:   (params['createdBy'] as string | undefined) ?? 'self',
          };

          const id = queue.enqueue(input);
          logger.info({ id, name, priority: rawPriority }, 'Task enqueued via tool');

          return {
            success: true,
            output:  `Task enqueued. ID: ${id}\nName: ${name}\nPriority: ${rawPriority}\nStatus: ${dependsOn.length > 0 ? 'blocked (waiting on dependencies)' : 'queued (ready to run)'}`,
            data:    { id, name, priority: rawPriority, dependsOn },
          };
        }

        // -------------------------------------------------------------------
        case 'list': {
          const filterStatus = params['filterStatus'] as string | undefined;
          const filterPriority = params['filterPriority'] as string | undefined;
          const limit = Math.min(200, Math.max(1, (params['limit'] as number | undefined) ?? 20));

          if (filterStatus && !VALID_STATUSES.has(filterStatus)) {
            return { success: false, output: `Invalid filterStatus "${filterStatus}".` };
          }
          if (filterPriority && !VALID_PRIORITIES.has(filterPriority)) {
            return { success: false, output: `Invalid filterPriority "${filterPriority}".` };
          }

          const tasks = queue.listTasks({ status: filterStatus, priority: filterPriority, limit });

          if (tasks.length === 0) {
            return { success: true, output: 'No tasks found matching the filter.', data: [] };
          }

          const lines = tasks.map(t =>
            `[${t.id.slice(0, 8)}] ${t.status.padEnd(10)} ${t.priority.padEnd(10)} "${t.name}"` +
            (t.error ? ` | error: ${t.error.slice(0, 60)}` : '') +
            (t.retries > 0 ? ` | retries: ${t.retries}/${t.maxRetries}` : '')
          );

          return {
            success: true,
            output: `${tasks.length} task(s):\n${lines.join('\n')}`,
            data: tasks,
          };
        }

        // -------------------------------------------------------------------
        case 'get': {
          const taskId = (params['taskId'] as string | undefined)?.trim();
          if (!taskId) return { success: false, output: 'taskId is required for get.' };

          const { task, error } = resolveTaskId(queue, taskId);
          if (!task) return { success: false, output: error ?? `Task not found: ${taskId}` };

          const summary = [
            `ID:          ${task.id}`,
            `Name:        ${task.name}`,
            `Status:      ${task.status}`,
            `Priority:    ${task.priority}`,
            `Retries:     ${task.retries}/${task.maxRetries}`,
            `Created:     ${task.createdAt}`,
            task.startedAt   ? `Started:     ${task.startedAt}` : null,
            task.completedAt ? `Completed:   ${task.completedAt}` : null,
            task.dependsOn.length > 0 ? `Depends on:  ${task.dependsOn.join(', ')}` : null,
            task.error ? `Error:       ${task.error}` : null,
          ].filter(Boolean).join('\n');

          return { success: true, output: summary, data: task };
        }

        // -------------------------------------------------------------------
        case 'cancel': {
          const taskId = (params['taskId'] as string | undefined)?.trim();
          if (!taskId) return { success: false, output: 'taskId is required for cancel.' };

          const { task: before, error } = resolveTaskId(queue, taskId);
          if (!before) return { success: false, output: error ?? `Task not found: ${taskId}` };
          if (['completed', 'cancelled'].includes(before.status)) {
            return { success: false, output: `Task is already in terminal state: ${before.status}` };
          }

          queue.cancel(before.id);
          logger.info({ taskId: before.id }, 'Task cancelled via tool');
          return { success: true, output: `Task cancelled: ${before.id} (was: ${before.status})` };
        }

        // -------------------------------------------------------------------
        case 'stats': {
          const stats = queue.getStats();
          const total = stats.queued + stats.running + stats.completed + stats.failed + stats.blocked + stats.cancelled;
          const avgStr = stats.avgDurationMs != null
            ? `${Math.round(stats.avgDurationMs)}ms`
            : 'n/a';

          const output = [
            `Queue Statistics (${total} total tasks)`,
            `  Queued:    ${stats.queued}`,
            `  Running:   ${stats.running}`,
            `  Blocked:   ${stats.blocked}`,
            `  Completed: ${stats.completed}`,
            `  Failed:    ${stats.failed}`,
            `  Cancelled: ${stats.cancelled}`,
            `  Avg task duration: ${avgStr}`,
          ].join('\n');

          return { success: true, output, data: stats };
        }

        // -------------------------------------------------------------------
        case 'retry-failed': {
          const count = queue.retryFailed();
          const msg = count > 0
            ? `${count} failed task(s) re-queued for retry.`
            : 'No failed tasks with remaining retries found.';
          logger.info({ requeued: count }, 'retry-failed executed via tool');
          return { success: true, output: msg, data: { requeued: count } };
        }

        // -------------------------------------------------------------------
        case 'prune': {
          const rawDays = params['olderThanDays'];
          const olderThanDays = typeof rawDays === 'number' && Number.isFinite(rawDays)
            ? Math.max(0, rawDays)
            : 7;

          const removed = queue.pruneTerminal(olderThanDays);
          const msg = removed > 0
            ? `Pruned ${removed} terminal task(s) — completed/cancelled/failed older than ${olderThanDays} day(s).`
            : `No terminal tasks older than ${olderThanDays} day(s) to prune.`;
          logger.info({ removed, olderThanDays }, 'prune executed via tool');
          return { success: true, output: msg, data: { removed, olderThanDays } };
        }

        // -------------------------------------------------------------------
        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.task-manager error');
      return { success: false, output: `Task manager error: ${msg}` };
    }
  },
};
