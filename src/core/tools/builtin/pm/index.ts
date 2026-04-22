/**
 * Project Management toolkit — registers 3 PM tools into the ToolRegistry.
 *
 * Tools registered:
 *   pm.task-manager   — Tasks with dependencies, deadlines, priorities (JSON persistence)
 *   pm.project-planner — Generate project plans with milestones and timelines (LLM)
 *   pm.time-tracker   — Track time on tasks with billing integration (JSON persistence)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('pm-builtin');

const DATA_DIR = path.resolve('data');
const PM_TASKS_FILE = path.join(DATA_DIR, 'pm-tasks.json');
const TIME_LOG_FILE = path.join(DATA_DIR, 'pm-timelog.json');

// ---------------------------------------------------------------------------
// Shared LLM helper
// ---------------------------------------------------------------------------

interface BrainLike {
  chat(messages: Array<{ role: string; content: string }>): Promise<{ content: string }>;
}

interface ConfigLike { brain?: BrainLike; }

async function askBrain(ctx: ToolContext, system: string, user: string): Promise<string> {
  const config = ctx.config as ConfigLike | undefined;
  if (!config?.brain) throw new Error('Brain (LLM) is not available. Ensure the brain module is configured.');
  const response = await config.brain.chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  return response.content.trim();
}

// ---------------------------------------------------------------------------
// PM task helpers
// ---------------------------------------------------------------------------

type PMTaskStatus = 'todo' | 'in-progress' | 'blocked' | 'done' | 'cancelled';
type PMTaskPriority = 'low' | 'medium' | 'high' | 'critical';

interface PMTask {
  id: string;
  title: string;
  description: string;
  project: string;
  status: PMTaskStatus;
  priority: PMTaskPriority;
  assignee?: string;
  deadline?: string;
  dependencies: string[];
  tags: string[];
  estimatedHours?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadTasks(): PMTask[] {
  try {
    if (!existsSync(PM_TASKS_FILE)) return [];
    return JSON.parse(readFileSync(PM_TASKS_FILE, 'utf8')) as PMTask[];
  } catch { return []; }
}

function saveTasks(tasks: PMTask[]): void {
  ensureDataDir();
  writeFileSync(PM_TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// pm.task-manager
// ---------------------------------------------------------------------------

const taskManagerTool: ToolDefinition = {
  name: 'pm.task-manager',
  description:
    'Manage project tasks with dependencies, deadlines, priorities, and assignees. Persists to data/pm-tasks.json. Supports create, update, list, complete, and dependency management.',
  category: 'pm',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['create', 'update', 'list', 'get', 'complete', 'delete', 'blocked', 'stats'],
    },
    taskId: { type: 'string', description: 'Task ID (required for update, get, complete, delete).' },
    title: { type: 'string', description: 'Task title (required for create).' },
    description: { type: 'string', description: 'Task description.' },
    project: { type: 'string', description: 'Project name (required for create).' },
    status: { type: 'string', description: 'Task status.', enum: ['todo', 'in-progress', 'blocked', 'done', 'cancelled'] },
    priority: { type: 'string', description: 'Task priority.', enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    assignee: { type: 'string', description: 'Assignee name or ID.' },
    deadline: { type: 'string', description: 'Deadline in YYYY-MM-DD format.' },
    dependencies: { type: 'string', description: 'Comma-separated task IDs this task depends on.' },
    tags: { type: 'string', description: 'Comma-separated tags.' },
    estimatedHours: { type: 'number', description: 'Estimated hours to complete.' },
    projectFilter: { type: 'string', description: 'Filter list by project name.' },
    statusFilter: { type: 'string', description: 'Filter list by status.' },
    limit: { type: 'number', description: 'Max tasks to return (default: 50).', default: 50 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'pm.task-manager invoked');

    try {
      const tasks = loadTasks();

      switch (action) {
        case 'create': {
          const title = params['title'] as string | undefined;
          const project = (params['project'] as string | undefined) ?? 'default';
          if (!title?.trim()) return { success: false, output: 'title is required.' };
          const now = new Date().toISOString();
          const task: PMTask = {
            id: crypto.randomUUID(),
            title,
            description: (params['description'] as string | undefined) ?? '',
            project,
            status: 'todo',
            priority: (params['priority'] as PMTaskPriority | undefined) ?? 'medium',
            assignee: params['assignee'] as string | undefined,
            deadline: params['deadline'] as string | undefined,
            dependencies: ((params['dependencies'] as string | undefined) ?? '').split(',').map(s => s.trim()).filter(Boolean),
            tags: ((params['tags'] as string | undefined) ?? '').split(',').map(s => s.trim()).filter(Boolean),
            estimatedHours: params['estimatedHours'] as number | undefined,
            createdAt: now,
            updatedAt: now,
          };
          tasks.push(task);
          saveTasks(tasks);
          return { success: true, output: `Task created: "${title}" (${task.id}) in project "${project}"`, data: task };
        }

        case 'update': {
          const taskId = params['taskId'] as string | undefined;
          if (!taskId?.trim()) return { success: false, output: 'taskId is required.' };
          const idx = tasks.findIndex(t => t.id === taskId);
          if (idx === -1) return { success: false, output: `Task not found: ${taskId}` };
          const t = tasks[idx]!;
          if (params['title']) t.title = params['title'] as string;
          if (params['description']) t.description = params['description'] as string;
          if (params['status']) t.status = params['status'] as PMTaskStatus;
          if (params['priority']) t.priority = params['priority'] as PMTaskPriority;
          if (params['assignee']) t.assignee = params['assignee'] as string;
          if (params['deadline']) t.deadline = params['deadline'] as string;
          if (params['estimatedHours']) t.estimatedHours = params['estimatedHours'] as number;
          if (params['dependencies']) t.dependencies = (params['dependencies'] as string).split(',').map(s => s.trim()).filter(Boolean);
          t.updatedAt = new Date().toISOString();
          saveTasks(tasks);
          return { success: true, output: `Task updated: "${t.title}"`, data: t };
        }

        case 'list': {
          const limit = (params['limit'] as number | undefined) ?? 50;
          const projectFilter = params['projectFilter'] as string | undefined;
          const statusFilter = params['statusFilter'] as string | undefined;
          let filtered = tasks;
          if (projectFilter) filtered = filtered.filter(t => t.project === projectFilter);
          if (statusFilter) filtered = filtered.filter(t => t.status === statusFilter);
          const results = filtered.slice(0, limit);
          return {
            success: true,
            output: results.length > 0
              ? `${results.length} task(s):\n${results.map(t => `[${t.status}][${t.priority}] ${t.title} (${t.id}) — ${t.project}${t.deadline ? ` due:${t.deadline}` : ''}`).join('\n')}`
              : 'No tasks found.',
            data: results,
          };
        }

        case 'get': {
          const taskId = params['taskId'] as string | undefined;
          if (!taskId?.trim()) return { success: false, output: 'taskId is required.' };
          const t = tasks.find(t => t.id === taskId);
          if (!t) return { success: false, output: `Task not found: ${taskId}` };
          const blockedBy = t.dependencies.filter(dep => tasks.find(d => d.id === dep && d.status !== 'done'));
          return { success: true, output: `Task: "${t.title}" | Status: ${t.status} | Priority: ${t.priority} | Project: ${t.project} | Blocked by: ${blockedBy.length > 0 ? blockedBy.join(', ') : 'none'}`, data: { task: t, blockedBy } };
        }

        case 'complete': {
          const taskId = params['taskId'] as string | undefined;
          if (!taskId?.trim()) return { success: false, output: 'taskId is required.' };
          const idx = tasks.findIndex(t => t.id === taskId);
          if (idx === -1) return { success: false, output: `Task not found: ${taskId}` };
          tasks[idx]!.status = 'done';
          tasks[idx]!.completedAt = new Date().toISOString();
          tasks[idx]!.updatedAt = new Date().toISOString();
          saveTasks(tasks);
          return { success: true, output: `Task completed: "${tasks[idx]!.title}"`, data: tasks[idx] };
        }

        case 'delete': {
          const taskId = params['taskId'] as string | undefined;
          if (!taskId?.trim()) return { success: false, output: 'taskId is required.' };
          const idx = tasks.findIndex(t => t.id === taskId);
          if (idx === -1) return { success: false, output: `Task not found: ${taskId}` };
          const removed = tasks.splice(idx, 1)[0]!;
          saveTasks(tasks);
          return { success: true, output: `Task deleted: "${removed.title}"` };
        }

        case 'blocked': {
          const blocked = tasks.filter(t => {
            if (t.status === 'done' || t.status === 'cancelled') return false;
            return t.dependencies.some(dep => tasks.find(d => d.id === dep && d.status !== 'done'));
          });
          return { success: true, output: blocked.length > 0 ? `${blocked.length} blocked task(s):\n${blocked.map(t => `${t.title} (blocked by: ${t.dependencies.join(', ')})`).join('\n')}` : 'No blocked tasks.', data: blocked };
        }

        case 'stats': {
          const byStatus = tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {} as Record<string, number>);
          const projects = [...new Set(tasks.map(t => t.project))];
          return { success: true, output: `Tasks: ${tasks.length} total | ${Object.entries(byStatus).map(([s, n]) => `${s}:${n}`).join(' ')} | Projects: ${projects.join(', ')}`, data: { total: tasks.length, byStatus, projects } };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'pm.task-manager error');
      return { success: false, output: `Task manager error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// pm.project-planner
// ---------------------------------------------------------------------------

const projectPlannerTool: ToolDefinition = {
  name: 'pm.project-planner',
  description:
    'Generate a complete project plan with milestones, task breakdown, timelines, resource requirements, and risk assessment using AI.',
  category: 'pm',
  timeout: 90_000,
  parameters: {
    projectName: { type: 'string', required: true, description: 'Name of the project to plan.' },
    description: { type: 'string', required: true, description: 'What the project delivers and its goals.' },
    teamSize: { type: 'number', description: 'Number of people on the team (default: 3).', default: 3 },
    durationWeeks: { type: 'number', description: 'Target duration in weeks (default: 12).', default: 12 },
    methodology: { type: 'string', description: 'Project methodology.', enum: ['agile', 'waterfall', 'kanban', 'hybrid'], default: 'agile' },
    constraints: { type: 'string', description: 'Known constraints (budget, technology, regulatory).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const projectName = params['projectName'] as string | undefined;
    const description = params['description'] as string | undefined;
    const teamSize = (params['teamSize'] as number | undefined) ?? 3;
    const durationWeeks = (params['durationWeeks'] as number | undefined) ?? 12;
    const methodology = (params['methodology'] as string | undefined) ?? 'agile';
    const constraints = (params['constraints'] as string | undefined) ?? '';
    logger.info({ session: ctx.sessionId, projectName }, 'pm.project-planner invoked');

    if (!projectName?.trim()) return { success: false, output: 'projectName is required.' };
    if (!description?.trim()) return { success: false, output: 'description is required.' };

    try {
      const system = `You are a senior project manager (PMP certified) experienced in ${methodology} methodology. Create realistic, actionable project plans.`;
      const user = `Create a project plan for: "${projectName}"
Description: ${description}
Team size: ${teamSize} | Duration: ${durationWeeks} weeks | Methodology: ${methodology}
${constraints ? `Constraints: ${constraints}` : ''}

Provide:
1. PROJECT OVERVIEW (objectives, success criteria, scope boundaries)
2. MILESTONE PLAN (5-8 milestones with target weeks)
3. WORK BREAKDOWN STRUCTURE (epics → stories/tasks with estimates in days)
4. SPRINT/PHASE PLAN (week-by-week breakdown for first 4 weeks, then phase summaries)
5. RESOURCE PLAN (roles needed, responsibilities, allocation %)
6. RISK REGISTER (top 5 risks: probability|impact|mitigation)
7. DEPENDENCIES MAP (critical path items)
8. DEFINITION OF DONE (acceptance criteria for each milestone)`;

      const output = await askBrain(ctx, system, user);
      logger.info({ projectName, durationWeeks }, 'Project plan generated');
      return { success: true, output, data: { projectName, teamSize, durationWeeks, methodology } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ projectName, err: msg }, 'pm.project-planner error');
      return { success: false, output: `Project planner error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// pm.time-tracker — time log helpers
// ---------------------------------------------------------------------------

interface TimeEntry {
  id: string;
  taskId?: string;
  taskName: string;
  project: string;
  startTime: string;
  endTime?: string;
  durationMinutes?: number;
  billable: boolean;
  hourlyRate?: number;
  notes: string;
}

function loadTimeLog(): TimeEntry[] {
  try {
    if (!existsSync(TIME_LOG_FILE)) return [];
    return JSON.parse(readFileSync(TIME_LOG_FILE, 'utf8')) as TimeEntry[];
  } catch { return []; }
}

function saveTimeLog(entries: TimeEntry[]): void {
  ensureDataDir();
  writeFileSync(TIME_LOG_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

const timeTrackerTool: ToolDefinition = {
  name: 'pm.time-tracker',
  description:
    'Track time spent on tasks with billing integration. Start/stop timers, log manual entries, generate time reports, and calculate billable amounts.',
  category: 'pm',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['start', 'stop', 'log', 'list', 'report', 'stats'],
    },
    entryId: { type: 'string', description: 'Time entry ID (required for stop).' },
    taskName: { type: 'string', description: 'Task name (required for start and log).' },
    project: { type: 'string', description: 'Project name (required for start and log).' },
    taskId: { type: 'string', description: 'Associated PM task ID.' },
    durationMinutes: { type: 'number', description: 'Duration in minutes (required for log).' },
    billable: { type: 'boolean', description: 'Whether this time is billable (default: true).', default: true },
    hourlyRate: { type: 'number', description: 'Hourly rate in USD for billing calculation.' },
    notes: { type: 'string', description: 'Notes about the work done.' },
    projectFilter: { type: 'string', description: 'Filter by project name.' },
    dateFrom: { type: 'string', description: 'Filter entries from this date (YYYY-MM-DD).' },
    dateTo: { type: 'string', description: 'Filter entries to this date (YYYY-MM-DD).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'pm.time-tracker invoked');

    try {
      const entries = loadTimeLog();

      switch (action) {
        case 'start': {
          const taskName = params['taskName'] as string | undefined;
          const project = (params['project'] as string | undefined) ?? 'default';
          if (!taskName?.trim()) return { success: false, output: 'taskName is required for start.' };
          // Stop any currently running entry
          const running = entries.find(e => !e.endTime);
          if (running) {
            running.endTime = new Date().toISOString();
            const start = new Date(running.startTime).getTime();
            running.durationMinutes = Math.round((Date.now() - start) / 60_000);
          }
          const entry: TimeEntry = {
            id: crypto.randomUUID(),
            taskId: params['taskId'] as string | undefined,
            taskName,
            project,
            startTime: new Date().toISOString(),
            billable: (params['billable'] as boolean | undefined) ?? true,
            hourlyRate: params['hourlyRate'] as number | undefined,
            notes: (params['notes'] as string | undefined) ?? '',
          };
          entries.push(entry);
          saveTimeLog(entries);
          return { success: true, output: `Timer started for "${taskName}" in project "${project}" (id: ${entry.id})`, data: entry };
        }

        case 'stop': {
          const entryId = params['entryId'] as string | undefined;
          const running = entryId ? entries.find(e => e.id === entryId) : entries.find(e => !e.endTime);
          if (!running) return { success: false, output: 'No running timer found.' };
          running.endTime = new Date().toISOString();
          const start = new Date(running.startTime).getTime();
          running.durationMinutes = Math.round((Date.now() - start) / 60_000);
          if (params['notes']) running.notes = params['notes'] as string;
          saveTimeLog(entries);
          const hours = (running.durationMinutes / 60).toFixed(2);
          const billableAmt = running.billable && running.hourlyRate ? ` | Billable: $${((running.durationMinutes / 60) * running.hourlyRate).toFixed(2)}` : '';
          return { success: true, output: `Timer stopped: "${running.taskName}" — ${running.durationMinutes}m (${hours}h)${billableAmt}`, data: running };
        }

        case 'log': {
          const taskName = params['taskName'] as string | undefined;
          const durationMinutes = params['durationMinutes'] as number | undefined;
          if (!taskName?.trim()) return { success: false, output: 'taskName is required for log.' };
          if (!durationMinutes || durationMinutes <= 0) return { success: false, output: 'durationMinutes must be positive.' };
          const now = new Date();
          const startTime = new Date(now.getTime() - durationMinutes * 60_000).toISOString();
          const entry: TimeEntry = {
            id: crypto.randomUUID(),
            taskId: params['taskId'] as string | undefined,
            taskName,
            project: (params['project'] as string | undefined) ?? 'default',
            startTime,
            endTime: now.toISOString(),
            durationMinutes,
            billable: (params['billable'] as boolean | undefined) ?? true,
            hourlyRate: params['hourlyRate'] as number | undefined,
            notes: (params['notes'] as string | undefined) ?? '',
          };
          entries.push(entry);
          saveTimeLog(entries);
          return { success: true, output: `Logged ${durationMinutes}m for "${taskName}"`, data: entry };
        }

        case 'list': {
          const projectFilter = params['projectFilter'] as string | undefined;
          const dateFrom = params['dateFrom'] as string | undefined;
          const dateTo = params['dateTo'] as string | undefined;
          let filtered = entries.filter(e => e.endTime);
          if (projectFilter) filtered = filtered.filter(e => e.project === projectFilter);
          if (dateFrom) filtered = filtered.filter(e => e.startTime >= dateFrom);
          if (dateTo) filtered = filtered.filter(e => e.startTime <= dateTo + 'T23:59:59');
          const lines = filtered.slice(-50).map(e => `${e.startTime.split('T')[0]} | ${e.project} | ${e.taskName} | ${e.durationMinutes}m${e.billable ? ' [billable]' : ''}`);
          return { success: true, output: lines.length > 0 ? `${lines.length} entries:\n${lines.join('\n')}` : 'No entries found.', data: filtered };
        }

        case 'report': {
          const projectFilter = params['projectFilter'] as string | undefined;
          const completed = entries.filter(e => e.endTime);
          const filtered = projectFilter ? completed.filter(e => e.project === projectFilter) : completed;
          const totalMinutes = filtered.reduce((s, e) => s + (e.durationMinutes ?? 0), 0);
          const billableMinutes = filtered.filter(e => e.billable).reduce((s, e) => s + (e.durationMinutes ?? 0), 0);
          const billableAmount = filtered.filter(e => e.billable && e.hourlyRate).reduce((s, e) => s + ((e.durationMinutes ?? 0) / 60) * (e.hourlyRate ?? 0), 0);
          const byProject = filtered.reduce((acc, e) => { acc[e.project] = (acc[e.project] ?? 0) + (e.durationMinutes ?? 0); return acc; }, {} as Record<string, number>);
          const projectLines = Object.entries(byProject).map(([p, m]) => `  ${p}: ${(m / 60).toFixed(1)}h`);
          return {
            success: true,
            output: `Time Report${projectFilter ? ` (${projectFilter})` : ''}:\nTotal: ${(totalMinutes / 60).toFixed(1)}h | Billable: ${(billableMinutes / 60).toFixed(1)}h | Revenue: $${billableAmount.toFixed(2)}\nBy project:\n${projectLines.join('\n')}`,
            data: { totalHours: totalMinutes / 60, billableHours: billableMinutes / 60, billableAmount, byProject },
          };
        }

        case 'stats': {
          const running = entries.filter(e => !e.endTime);
          const completed = entries.filter(e => e.endTime);
          return { success: true, output: `Time log: ${completed.length} completed entries | ${running.length} running`, data: { completed: completed.length, running: running.length } };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'pm.time-tracker error');
      return { success: false, output: `Time tracker error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const PM_TOOLS: ToolDefinition[] = [
  taskManagerTool,
  projectPlannerTool,
  timeTrackerTool,
];

/**
 * Register all project management tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerPmTools(registry: ToolRegistry): void {
  logger.info({ count: PM_TOOLS.length }, 'Registering PM tools');
  for (const tool of PM_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: PM_TOOLS.length }, 'PM tools registered');
}
