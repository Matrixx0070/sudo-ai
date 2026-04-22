/**
 * meta.smart-scheduler — SUDO-AI's dependency-aware, audience-optimised scheduling tool.
 *
 * Actions:
 *   schedule      — Register a new task with optional deps, optimal time, cooldown
 *   unschedule    — Remove a task by ID
 *   list          — List all tasks (optionally filtered by enabled state)
 *   optimal-time  — Return the next optimal IST posting time for a content type
 *   ready-tasks   — Return tasks eligible to run right now
 *   stats         — Return total / enabled / overdue counts
 *   optimize      — Reschedule overdue normal/low tasks to next IST peak slots
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { SmartScheduler, type NewTask } from '../../../scheduling/smart-scheduler.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta-smart-scheduler');

const DB_PATH = path.resolve('/root/sudo-ai-v4/data/mind.db');

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _scheduler: SmartScheduler | null = null;

function getScheduler(): SmartScheduler {
  if (!_scheduler) {
    _scheduler = new SmartScheduler(DB_PATH);
  }
  return _scheduler;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_PRIORITIES = new Set(['critical', 'high', 'normal', 'low']);

function validatePriority(p: unknown): p is NewTask['priority'] {
  return typeof p === 'string' && VALID_PRIORITIES.has(p);
}

/** Parse a boolean-ish param (accepts true/false/"true"/"false"/1/0). */
function parseBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const smartSchedulerTool: ToolDefinition = {
  name: 'meta.smart-scheduler',
  description:
    'Smart scheduling with dependency chains, IST audience-optimised posting times, and cooldown enforcement. ' +
    'Actions: schedule (register a task), unschedule (remove it), list (view all tasks), ' +
    'optimal-time (get next best IST post slot for a content type), ready-tasks (which tasks can run now), ' +
    'stats (totals + overdue count), optimize (reschedule overdue tasks to next peak slots).',
  category: 'meta',
  timeout: 20_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['schedule', 'unschedule', 'list', 'optimal-time', 'ready-tasks', 'stats', 'optimize'],
    },

    // --- schedule params ---
    name: {
      type: 'string',
      description: '[schedule] Human-readable task name, e.g. "render-video-pipeline".',
    },
    cronExpression: {
      type: 'string',
      description: '[schedule] Standard cron string, e.g. "0 8 * * *". Omit for one-shot tasks.',
    },
    dependencies: {
      type: 'array',
      description: '[schedule] Array of task IDs that must have run before this task is eligible.',
      items: { type: 'string', description: 'Task ID' },
    },
    optimalTime: {
      type: 'string',
      description: '[schedule] Preferred execution time in HH:MM (24h, IST). Leave empty to auto-pick next peak slot.',
    },
    timezone: {
      type: 'string',
      description: '[schedule] IANA timezone identifier. Defaults to "UTC".',
      default: 'UTC',
    },
    cooldownMs: {
      type: 'number',
      description: '[schedule] Minimum milliseconds between executions (default 0 = no cooldown).',
      default: 0,
    },
    priority: {
      type: 'string',
      description: '[schedule] Task priority. Critical tasks bypass the next_run gate.',
      enum: ['critical', 'high', 'normal', 'low'],
      default: 'normal',
    },
    enabled: {
      type: 'boolean',
      description: '[schedule] Whether the task is active (default true).',
      default: true,
    },
    payload: {
      type: 'object',
      description: '[schedule] Arbitrary JSON payload stored with the task.',
      properties: {},
    },

    // --- unschedule / ready-tasks (dependency check) ---
    taskId: {
      type: 'string',
      description: '[unschedule] ID of the task to remove.',
    },

    // --- list filter ---
    filterEnabled: {
      type: 'boolean',
      description: '[list] If provided, filter by enabled state.',
    },

    // --- optimal-time ---
    contentType: {
      type: 'string',
      description: '[optimal-time] Content type hint (e.g. "news", "video", "quiz"). Morning types get early slots.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.smart-scheduler invoked');

    try {
      const sched = getScheduler();

      switch (action) {

        // -------------------------------------------------------------------
        case 'schedule': {
          const name = (params['name'] as string | undefined)?.trim();
          if (!name) return { success: false, output: 'name is required for schedule.' };

          const rawPriority = (params['priority'] as string | undefined) ?? 'normal';
          if (!validatePriority(rawPriority)) {
            return { success: false, output: `Invalid priority "${rawPriority}". Must be one of: ${[...VALID_PRIORITIES].join(', ')}` };
          }

          const cooldownMs = params['cooldownMs'] !== undefined
            ? Math.max(0, Math.floor(params['cooldownMs'] as number))
            : 0;

          const dependencies = Array.isArray(params['dependencies'])
            ? (params['dependencies'] as unknown[]).filter(v => typeof v === 'string') as string[]
            : [];

          const enabledRaw = parseBool(params['enabled']);
          const enabled = enabledRaw !== undefined ? enabledRaw : true;

          const task: NewTask = {
            name,
            cronExpression:  (params['cronExpression'] as string | undefined) ?? null,
            dependencies,
            optimalTime:     (params['optimalTime'] as string | undefined) ?? null,
            timezone:        (params['timezone'] as string | undefined) ?? 'UTC',
            cooldownMs,
            priority:        rawPriority,
            enabled,
            lastRun:         null,
            payload:         params['payload'] ?? {},
          };

          const id = sched.schedule(task);
          logger.info({ id, name, priority: rawPriority }, 'Task scheduled via tool');

          return {
            success: true,
            output:  `Task scheduled.\nID: ${id}\nName: ${name}\nPriority: ${rawPriority}\nDependencies: ${dependencies.length > 0 ? dependencies.join(', ') : 'none'}`,
            data:    { id, name, priority: rawPriority, dependencies, enabled },
          };
        }

        // -------------------------------------------------------------------
        case 'unschedule': {
          const taskId = (params['taskId'] as string | undefined)?.trim();
          if (!taskId) return { success: false, output: 'taskId is required for unschedule.' };
          sched.unschedule(taskId);
          return { success: true, output: `Task removed: ${taskId}` };
        }

        // -------------------------------------------------------------------
        case 'list': {
          const filterEnabled = parseBool(params['filterEnabled']);
          const tasks = sched.listTasks(filterEnabled !== undefined ? { enabled: filterEnabled } : undefined);

          if (tasks.length === 0) {
            return { success: true, output: 'No scheduled tasks found.', data: [] };
          }

          const lines = tasks.map(t => {
            const depStr = t.dependencies.length > 0 ? ` | deps: ${t.dependencies.join(', ')}` : '';
            const coolStr = t.cooldownMs > 0 ? ` | cooldown: ${t.cooldownMs}ms` : '';
            const nextStr = t.nextRun ? ` | next: ${t.nextRun}` : '';
            const state = t.enabled ? 'ON ' : 'OFF';
            return `[${t.id.slice(0, 8)}] ${state} ${t.priority.padEnd(8)} "${t.name}"${nextStr}${depStr}${coolStr}`;
          });

          return {
            success: true,
            output:  `${tasks.length} scheduled task(s):\n${lines.join('\n')}`,
            data:    tasks,
          };
        }

        // -------------------------------------------------------------------
        case 'optimal-time': {
          const contentType = (params['contentType'] as string | undefined)?.trim() ?? 'general';
          const iso = sched.getOptimalPostTime(contentType);
          const date = new Date(iso);
          const formatted = date.toUTCString();
          return {
            success: true,
            output:  `Next optimal post time for "${contentType}":\n${iso}\n(${formatted})\nTimezone basis: UTC peak hours`,
            data:    { contentType, iso, utc: formatted },
          };
        }

        // -------------------------------------------------------------------
        case 'ready-tasks': {
          const ready = sched.getReadyTasks();
          if (ready.length === 0) {
            return { success: true, output: 'No tasks are ready to run right now.', data: [] };
          }
          const lines = ready.map(t =>
            `[${t.id.slice(0, 8)}] ${t.priority.padEnd(8)} "${t.name}"` +
            (t.nextRun ? ` | next_run: ${t.nextRun}` : '') +
            (t.lastRun ? ` | last_run: ${t.lastRun}` : '')
          );
          return {
            success: true,
            output:  `${ready.length} task(s) ready to run:\n${lines.join('\n')}`,
            data:    ready,
          };
        }

        // -------------------------------------------------------------------
        case 'stats': {
          const stats = sched.getStats();
          const output = [
            `Smart Scheduler Statistics`,
            `  Total tasks:   ${stats.total}`,
            `  Enabled:       ${stats.enabled}`,
            `  Overdue:       ${stats.overdue}`,
          ].join('\n');
          return { success: true, output, data: stats };
        }

        // -------------------------------------------------------------------
        case 'optimize': {
          sched.optimizeSchedule();
          const stats = sched.getStats();
          return {
            success: true,
            output:  `Schedule optimised. Overdue tasks rescheduled to next IST peak slots.\nCurrent overdue: ${stats.overdue}`,
            data:    stats,
          };
        }

        // -------------------------------------------------------------------
        default:
          return { success: false, output: `Unknown action: "${action}"` };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.smart-scheduler error');
      return { success: false, output: `Smart scheduler error: ${msg}` };
    }
  },
};
