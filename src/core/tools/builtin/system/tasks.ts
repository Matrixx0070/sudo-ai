/**
 * system.tasks — Persistent task list backed by data/tasks.json.
 *
 * SUDO uses this tool to track its own work across sessions. Tasks are stored
 * as a flat JSON array. IDs are generated via crypto.randomUUID (built-in to
 * Node.js 22 — no external dependency required).
 *
 * Operations: create | list | update | complete | delete
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const logger = createLogger('system.tasks');

const TASKS_FILE = path.resolve('data/tasks.json');
const TASKS_DIR = path.dirname(TASKS_FILE);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskStatus = 'pending' | 'in-progress' | 'blocked' | 'done';
type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function loadTasks(): Promise<Task[]> {
  try {
    if (!existsSync(TASKS_FILE)) return [];
    const raw = await readFile(TASKS_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Task[]) : [];
  } catch {
    return [];
  }
}

async function saveTasks(tasks: Task[]): Promise<void> {
  await mkdir(TASKS_DIR, { recursive: true });
  // Write atomically: write to a temp file then rename so a crash mid-write
  // cannot leave TASKS_FILE truncated/corrupt.
  const tmpFile = `${TASKS_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmpFile, JSON.stringify(tasks, null, 2), 'utf8');
  await rename(tmpFile, TASKS_FILE);
}

// Serialize all read-modify-write operations so concurrent invocations cannot
// clobber each other's updates. Each operation awaits the previous one.
let opQueue: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opQueue.then(fn, fn);
  // Keep the chain alive regardless of whether fn rejected.
  opQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Find a single task by exact id, or by unique prefix when no exact match
 * exists. Returns 'ambiguous' when a prefix matches more than one task so the
 * caller can refuse to act on the wrong task.
 */
function findTask(tasks: Task[], id: string): Task | undefined | 'ambiguous' {
  const exact = tasks.find((t) => t.id === id);
  if (exact) return exact;
  const matches = tasks.filter((t) => t.id.startsWith(id));
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return 'ambiguous';
  return matches[0];
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function formatTask(t: Task): string {
  const flag = t.status === 'done' ? '[x]' : '[ ]';
  const pri = t.priority.toUpperCase().padEnd(6);
  const status = t.status.padEnd(11);
  const done = t.completedAt ? ` (completed ${t.completedAt.slice(0, 10)})` : '';
  return `${flag} [${pri}] [${status}] ${t.id.slice(0, 8)} — ${t.title}${done}`;
}

function formatList(tasks: Task[]): string {
  if (tasks.length === 0) return 'No tasks found.';
  return sortTasks(tasks).map(formatTask).join('\n');
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function opCreate(
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const title = params['title'];
  if (typeof title !== 'string' || title.trim() === '') {
    return { success: false, output: 'system.tasks create: "title" is required.', data: {} };
  }

  const priority = (['low', 'medium', 'high', 'urgent'].includes(String(params['priority']))
    ? params['priority']
    : 'medium') as TaskPriority;

  const task: Task = {
    id: crypto.randomUUID(),
    title: title.trim(),
    status: 'pending',
    priority,
    createdAt: new Date().toISOString(),
  };

  const tasks = await loadTasks();
  tasks.push(task);
  await saveTasks(tasks);

  logger.info({ session: ctx.sessionId, taskId: task.id, title: task.title }, 'Task created');
  return {
    success: true,
    output: `Task created: ${task.id.slice(0, 8)} — ${task.title}`,
    data: { task },
  };
}

async function opList(_params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tasks = await loadTasks();
  logger.info({ session: ctx.sessionId, count: tasks.length }, 'Listing tasks');
  return {
    success: true,
    output: `Tasks (${tasks.length}):\n${formatList(tasks)}`,
    data: { count: tasks.length, tasks: sortTasks(tasks) },
  };
}

async function opUpdate(
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = String(params['id'] ?? '').trim();
  if (!id) return { success: false, output: 'system.tasks update: "id" is required.', data: {} };

  const tasks = await loadTasks();
  const task = findTask(tasks, id);
  if (task === 'ambiguous') return { success: false, output: `system.tasks: id "${id}" matches multiple tasks; provide a more specific id.`, data: {} };
  if (!task) return { success: false, output: `system.tasks: no task found matching id "${id}".`, data: {} };

  const validStatuses: TaskStatus[] = ['pending', 'in-progress', 'blocked', 'done'];
  const validPriorities: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

  if (typeof params['status'] === 'string' && validStatuses.includes(params['status'] as TaskStatus)) {
    task.status = params['status'] as TaskStatus;
  }
  if (typeof params['priority'] === 'string' && validPriorities.includes(params['priority'] as TaskPriority)) {
    task.priority = params['priority'] as TaskPriority;
  }

  await saveTasks(tasks);
  logger.info({ session: ctx.sessionId, taskId: task.id }, 'Task updated');
  return { success: true, output: `Task updated:\n${formatTask(task)}`, data: { task } };
}

async function opComplete(
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = String(params['id'] ?? '').trim();
  if (!id) return { success: false, output: 'system.tasks complete: "id" is required.', data: {} };

  const tasks = await loadTasks();
  const task = findTask(tasks, id);
  if (task === 'ambiguous') return { success: false, output: `system.tasks: id "${id}" matches multiple tasks; provide a more specific id.`, data: {} };
  if (!task) return { success: false, output: `system.tasks: no task found matching id "${id}".`, data: {} };

  task.status = 'done';
  task.completedAt = new Date().toISOString();
  await saveTasks(tasks);

  logger.info({ session: ctx.sessionId, taskId: task.id }, 'Task completed');
  return { success: true, output: `Task completed:\n${formatTask(task)}`, data: { task } };
}

async function opDelete(
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = String(params['id'] ?? '').trim();
  if (!id) return { success: false, output: 'system.tasks delete: "id" is required.', data: {} };

  const tasks = await loadTasks();
  const exactIdx = tasks.findIndex((t) => t.id === id);
  const prefixMatches = tasks.filter((t) => t.id.startsWith(id));
  let idx = exactIdx;
  if (idx === -1) {
    if (prefixMatches.length > 1) return { success: false, output: `system.tasks: id "${id}" matches multiple tasks; provide a more specific id.`, data: {} };
    idx = tasks.findIndex((t) => t.id.startsWith(id));
  }
  if (idx === -1) return { success: false, output: `system.tasks: no task found matching id "${id}".`, data: {} };

  const [removed] = tasks.splice(idx, 1);
  await saveTasks(tasks);

  logger.info({ session: ctx.sessionId, taskId: removed?.id }, 'Task deleted');
  return { success: true, output: `Task deleted: ${removed?.id?.slice(0, 8)} — ${removed?.title}`, data: { task: removed } };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const tasksTool: ToolDefinition = {
  name: 'system.tasks',
  description:
    'Manage a persistent task list. Create, update, list, and complete tasks. ' +
    'SUDO uses this to track its own work across sessions. Backed by data/tasks.json.',
  category: 'system',
  parameters: {
    operation: {
      type: 'string',
      required: true,
      enum: ['create', 'list', 'update', 'complete', 'delete'],
      description: 'Operation to perform.',
    },
    title: {
      type: 'string',
      required: false,
      description: 'Task title (required for create).',
    },
    id: {
      type: 'string',
      required: false,
      description: 'Task ID or prefix (required for update/complete/delete).',
    },
    status: {
      type: 'string',
      required: false,
      enum: ['pending', 'in-progress', 'blocked', 'done'],
      description: 'New status (for update).',
    },
    priority: {
      type: 'string',
      required: false,
      enum: ['low', 'medium', 'high', 'urgent'],
      description: 'Task priority (for create/update). Default: medium.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const operation = String(params['operation'] ?? '');
    try {
      // Serialize all operations so concurrent read-modify-write invocations
      // cannot clobber each other's updates.
      return await withLock(async () => {
        switch (operation) {
          case 'create':   return await opCreate(params, ctx);
          case 'list':     return await opList(params, ctx);
          case 'update':   return await opUpdate(params, ctx);
          case 'complete': return await opComplete(params, ctx);
          case 'delete':   return await opDelete(params, ctx);
          default:
            return { success: false, output: `system.tasks: unknown operation "${operation}".`, data: {} };
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ session: ctx.sessionId, operation, err }, 'Tasks operation failed');
      return { success: false, output: `system.tasks error: ${msg}`, data: {} };
    }
  },
};
