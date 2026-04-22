/**
 * heartbeat-tasks.ts — Per-task interval parsing + due-task filtering.
 * State file: workspace/memory/heartbeat-task-state.json
 * Format: { "system-health": "2026-04-11T09:00:00.000Z", ... }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('cron:heartbeat-tasks');

const TASK_STATE_SUBPATH = 'memory/heartbeat-task-state.json';

/** A single task entry parsed from HEARTBEAT.md frontmatter. */
export interface HeartbeatTask {
  name: string;
  intervalMs: number;
}

interface RawTask { name: string; interval: string; }

/** Persisted state — maps task name to last-run ISO timestamp. */
type TaskState = Record<string, string>;

/**
 * Parse an interval string like "30m", "2h", "1d" to milliseconds.
 * Returns null (warn logged) if format is not recognized — task treated as always due.
 */
export function parseInterval(s: string): number | null {
  const trimmed = s.trim();
  const m = /^(\d+)m$/.exec(trimmed);
  if (m) return parseInt(m[1]!, 10) * 60_000;
  const h = /^(\d+)h$/.exec(trimmed);
  if (h) return parseInt(h[1]!, 10) * 3_600_000;
  const d = /^(\d+)d$/.exec(trimmed);
  if (d) return parseInt(d[1]!, 10) * 86_400_000;
  log.warn({ interval: s }, 'heartbeat-tasks: unrecognised interval format — task treated as always due');
  return null;
}

/** Extract the YAML frontmatter block (between opening and closing ---). Returns null if absent. */
function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;

  const closingIdx = normalized.indexOf('\n---\n', 4);
  if (closingIdx === -1) return null;

  return normalized.slice(4, closingIdx);
}

/**
 * Parse the `tasks:` list from a YAML frontmatter block.
 * Handles: name: X / interval: Y under a `tasks:` key.
 * Returns [] if no tasks block found or parsing fails.
 */
export function parseFrontmatterTasks(frontmatter: string): HeartbeatTask[] {
  const lines = frontmatter.split('\n');
  const tasks: HeartbeatTask[] = [];

  let inTasksBlock = false;
  let current: Partial<RawTask> = {};

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Detect the `tasks:` key
    if (/^tasks:\s*$/.test(line)) {
      inTasksBlock = true;
      continue;
    }

    // Stop when we hit a new top-level key (not indented)
    if (inTasksBlock && /^[a-zA-Z]/.test(line)) {
      inTasksBlock = false;
    }

    if (!inTasksBlock) continue;

    // New list item
    const nameMatch = /^\s*-\s+name:\s+(.+)$/.exec(line);
    if (nameMatch) {
      // Flush the previous item if complete
      if (current.name && current.interval) {
        const ms = parseInterval(current.interval);
        tasks.push({ name: current.name, intervalMs: ms ?? 0 });
      }
      current = { name: nameMatch[1]!.trim() };
      continue;
    }

    const intervalMatch = /^\s+interval:\s+(.+)$/.exec(line);
    if (intervalMatch && current.name !== undefined) {
      current.interval = intervalMatch[1]!.trim();
      continue;
    }
  }

  // Flush the last item
  if (current.name && current.interval) {
    const ms = parseInterval(current.interval);
    tasks.push({ name: current.name, intervalMs: ms ?? 0 });
  }

  return tasks;
}

/** Load task-state JSON. Returns {} on missing file or parse error (non-fatal). */
export function loadTaskState(workspacePath: string): TaskState {
  const filePath = path.resolve(workspacePath, TASK_STATE_SUBPATH);
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as TaskState;
    }
    log.warn({ filePath }, 'heartbeat-task-state.json is not a plain object — resetting');
    return {};
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn({ err, filePath }, 'Failed to read heartbeat-task-state.json — treating all tasks as due');
    }
    return {};
  }
}

/** Persist task-state to disk. Failures are logged but never thrown. */
export function saveTaskState(workspacePath: string, state: TaskState): void {
  const filePath = path.resolve(workspacePath, TASK_STATE_SUBPATH);
  const dir = path.dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err: unknown) {
    log.error({ err, filePath }, 'Failed to persist heartbeat-task-state.json');
  }
}

/**
 * Return task names whose interval has elapsed since their last run.
 * Tasks with intervalMs === 0 (unrecognised format) are always considered due.
 */
export function getDueTasks(
  tasks: HeartbeatTask[],
  state: TaskState,
  now: Date = new Date(),
): string[] {
  if (tasks.length === 0) return [];

  const dueNames: string[] = [];
  const nowMs = now.getTime();

  for (const task of tasks) {
    const lastRunStr = state[task.name];
    if (!lastRunStr) {
      // Never run — always due
      dueNames.push(task.name);
      continue;
    }

    const lastRunMs = new Date(lastRunStr).getTime();
    if (isNaN(lastRunMs)) {
      log.warn({ task: task.name, lastRunStr }, 'Invalid last-run timestamp in state — treating as due');
      dueNames.push(task.name);
      continue;
    }

    const elapsed = nowMs - lastRunMs;
    if (task.intervalMs === 0 || elapsed >= task.intervalMs) {
      dueNames.push(task.name);
    }
  }

  return dueNames;
}

/** Mark tasks as just-run and persist the updated state. Call AFTER a successful tick. */
export function markTasksRun(
  workspacePath: string,
  state: TaskState,
  taskNames: string[],
  now: Date = new Date(),
): TaskState {
  const ts = now.toISOString();
  const updated: TaskState = { ...state };
  for (const name of taskNames) {
    updated[name] = ts;
  }
  saveTaskState(workspacePath, updated);
  return updated;
}

/**
 * Parse HEARTBEAT.md frontmatter and return { tasks, dueNames, state }.
 * Caller must call markTasksRun() after a successful tick.
 */
export function getHeartbeatDueTasks(
  heartbeatFilePath: string,
  workspacePath: string,
  now: Date = new Date(),
): { tasks: HeartbeatTask[]; dueNames: string[]; state: TaskState } {
  let content: string;
  try {
    content = readFileSync(heartbeatFilePath, 'utf8');
  } catch (err: unknown) {
    log.warn({ err, heartbeatFilePath }, 'Cannot read HEARTBEAT.md for task parsing');
    return { tasks: [], dueNames: [], state: {} };
  }

  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) {
    log.debug('HEARTBEAT.md has no frontmatter — all sections treated as due');
    return { tasks: [], dueNames: [], state: {} };
  }

  const tasks = parseFrontmatterTasks(frontmatter);
  if (tasks.length === 0) {
    log.debug('HEARTBEAT.md frontmatter has no tasks — all sections treated as due');
    return { tasks: [], dueNames: [], state: {} };
  }

  const state = loadTaskState(workspacePath);
  const dueNames = getDueTasks(tasks, state, now);

  log.debug(
    { total: tasks.length, due: dueNames.length, dueNames },
    'Heartbeat task due-check complete',
  );

  return { tasks, dueNames, state };
}
