/**
 * coder.todo — Model-callable plan / todo-list tool.
 *
 * Mirrors Claude Code's TodoWrite/TodoRead: lets the agent maintain a live,
 * session-scoped checklist of the work it is doing. The model calls this to
 * write down a plan, mark items in-progress/done/failed, and read progress
 * back — giving both the model and the owner a durable view of multi-step work.
 *
 * Backed by the existing {@link TaskTracker} engine. Each session gets its own
 * isolated tracker so concurrent sessions never see each other's plans.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { TaskTracker, type TrackedTask, type TaskStatus } from '../../../agent/task-tracker.js';

const logger = createLogger('coder.todo');

// ---------------------------------------------------------------------------
// Per-session tracker isolation
// ---------------------------------------------------------------------------

/** session id -> its own TaskTracker instance. */
const trackers = new Map<string, TaskTracker>();

function trackerFor(sessionId: string): TaskTracker {
  let t = trackers.get(sessionId);
  if (!t) {
    t = new TaskTracker();
    trackers.set(sessionId, t);
  }
  return t;
}

/** Exposed for tests: drop a session's tracker. */
export function _resetTodoTracker(sessionId: string): void {
  trackers.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<TaskStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  failed: '[!]',
};

function renderList(tasks: TrackedTask[], progress: string): string {
  if (tasks.length === 0) return 'No todos. Use action "add" to create a plan.';
  const lines = tasks.map((t, i) => {
    const icon = STATUS_ICON[t.status];
    const err = t.status === 'failed' && t.error ? ` — ${t.error}` : '';
    return `${String(i + 1).padStart(2)}. ${icon} ${t.subject}${err}  (${t.id})`;
  });
  return `${progress}\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const todoTool: ToolDefinition = {
  name: 'coder.todo',
  description:
    'Maintain a live, session-scoped todo/plan checklist while doing multi-step work — ' +
    "the equivalent of Claude Code's TodoWrite/TodoRead. " +
    'Use it to write down a plan before you start, then mark items in-progress/done/failed as you go. ' +
    'Actions: "add" (create one or more todos from subjects), "start" (mark in-progress), ' +
    '"complete" (mark done), "fail" (mark failed with an error), "list" (show current plan + progress), ' +
    '"clear" (wipe the plan for a fresh task). ' +
    'Reference items by their id (returned on add/list) for start/complete/fail.',
  category: 'coder',
  safety: 'readonly',
  timeout: 5_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: ['add', 'start', 'complete', 'fail', 'list', 'clear'],
      description:
        'What to do: add | start | complete | fail | list | clear. ' +
        '"add" needs "subjects"; start/complete/fail need "id" (fail also takes "error").',
    },
    subjects: {
      type: 'array',
      required: false,
      description:
        'For action "add": one or more todo descriptions to create, in order. ' +
        'Each becomes a pending item with its own id.',
      items: { type: 'string', description: 'A single todo description.' },
    },
    id: {
      type: 'string',
      required: false,
      description: 'For start/complete/fail: the todo id to transition (from add/list output).',
    },
    error: {
      type: 'string',
      required: false,
      description: 'For action "fail": human-readable reason the todo failed.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = typeof params['action'] === 'string' ? params['action'].trim() : '';
    const tracker = trackerFor(ctx.sessionId);
    logger.info({ session: ctx.sessionId, action }, 'coder.todo invoked');

    switch (action) {
      case 'add': {
        const raw = params['subjects'];
        const subjects: string[] = Array.isArray(raw)
          ? raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
          : typeof raw === 'string' && raw.trim() !== ''
            ? [raw.trim()]
            : [];
        if (subjects.length === 0) {
          return {
            success: false,
            output: 'coder.todo add: provide "subjects" (a non-empty array of todo descriptions).',
          };
        }
        const created = subjects.map((s) => tracker.create(s));
        return {
          success: true,
          output:
            `Added ${created.length} todo(s):\n` +
            renderList(tracker.list(), tracker.getProgress()),
          data: { added: created, tasks: tracker.list() },
        };
      }

      case 'start':
      case 'complete':
      case 'fail': {
        const id = typeof params['id'] === 'string' ? params['id'].trim() : '';
        if (!id) {
          return { success: false, output: `coder.todo ${action}: "id" is required.` };
        }
        if (!tracker.get(id)) {
          return {
            success: false,
            output: `coder.todo ${action}: no todo with id "${id}" in this session.\n` +
              renderList(tracker.list(), tracker.getProgress()),
          };
        }
        if (action === 'start') tracker.start(id);
        else if (action === 'complete') tracker.complete(id);
        else {
          const err = typeof params['error'] === 'string' ? params['error'] : 'unspecified failure';
          tracker.fail(id, err);
        }
        return {
          success: true,
          output: renderList(tracker.list(), tracker.getProgress()),
          data: { task: tracker.get(id), tasks: tracker.list() },
        };
      }

      case 'list': {
        return {
          success: true,
          output: renderList(tracker.list(), tracker.getProgress()),
          data: { tasks: tracker.list(), progress: tracker.getProgress() },
        };
      }

      case 'clear': {
        tracker.clear();
        return { success: true, output: 'Todo plan cleared.', data: { tasks: [] } };
      }

      default:
        return {
          success: false,
          output: `coder.todo: unknown action "${action}". Use add | start | complete | fail | list | clear.`,
        };
    }
  },
};

export default todoTool;
