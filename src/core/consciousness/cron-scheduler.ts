/**
 * @file cron-scheduler.ts
 * @description CronScheduler — in-process 5-field cron scheduler with deterministic jitter.
 *
 * Features:
 *   - Standard 5-field cron expressions (minute hour day-of-month month day-of-week)
 *   - Deterministic jitter: 10% of period (max 15 min) for recurring, up to 90s
 *     early for one-shot tasks landing on :00 or :30
 *   - One-shot tasks auto-delete after firing once
 *   - Recurring tasks auto-expire after 7 days
 *   - Missed task detection on restart (via persistTasks/loadTasks)
 *   - JSON persistence for durability across restarts
 *
 * Designed as a lightweight alternative to node-cron for embedded agent scheduling.
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { existsSync, readFileSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'fs';

const log = createLogger('consciousness:cron-scheduler');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Task kind: recurring runs on every cron match; one-shot fires once then auto-deletes. */
export type TaskKind = 'recurring' | 'one-shot';

/** A scheduled cron task. */
export interface CronTask {
  /** Unique task identifier. */
  id: string;
  /** 5-field cron expression (M H DoM Mon DoW). */
  cron: string;
  /** The prompt/callback identifier to fire when the schedule matches. */
  prompt: string;
  /** Whether this is a recurring or one-shot task. */
  kind: TaskKind;
  /** ISO-8601 timestamp when this task was created. */
  createdAt: string;
  /** ISO-8601 timestamp when this task last fired (null if never). */
  lastFiredAt: string | null;
  /** ISO-8601 timestamp when this task expires (recurring: createdAt + 7 days). */
  expiresAt: string;
  /** Whether this task is durable (persists to disk) or session-only. */
  durable: boolean;
}

/** Result of a cron match check. */
export interface CronMatch {
  /** The task that matched. */
  task: CronTask;
  /** The computed fire time (with jitter applied). */
  fireAt: Date;
}

/** Configuration for the CronScheduler. */
export interface CronSchedulerConfig {
  /** Path to the JSON file for durable task persistence. */
  persistencePath: string;
  /** Recurring task auto-expiry in days (default 7). */
  recurringExpiryDays: number;
  /** Maximum jitter as fraction of period (default 0.10 = 10%). */
  maxJitterFraction: number;
  /** Maximum absolute jitter in milliseconds (default 15 min). */
  maxJitterMs: number;
}

const DEFAULT_CONFIG: Readonly<CronSchedulerConfig> = {
  persistencePath: 'data/consciousness/cron-tasks.json',
  recurringExpiryDays: 7,
  maxJitterFraction: 0.10,
  maxJitterMs: 15 * 60 * 1000, // 15 minutes
};

// ---------------------------------------------------------------------------
// Cron expression parser
// ---------------------------------------------------------------------------

interface CronFields {
  minute: number[];   // 0-59
  hour: number[];     // 0-23
  dayOfMonth: number[]; // 1-31
  month: number[];    // 1-12
  dayOfWeek: number[]; // 0-6 (0 = Sunday)
}

/**
 * Parse a 5-field cron expression into discrete field values.
 * Supports: star, ranges (1-5), steps (star/5), and lists (1,3,5).
 */
function parseCronExpression(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${expr}" — expected 5 fields, got ${parts.length}`);
  }

  const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

  return {
    minute: parseField(minuteStr, 0, 59),
    hour: parseField(hourStr, 0, 23),
    dayOfMonth: parseField(domStr, 1, 31),
    month: parseField(monthStr, 1, 12),
    dayOfWeek: parseField(dowStr, 0, 6, true),
  };
}

/**
 * Parse a single cron field into an array of matching integer values.
 */
function parseField(field: string, min: number, max: number, allowSeven = false): number[] {
  if (field === '*') {
    return range(min, max);
  }

  const values: number[] = [];

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      // Step: */5 or 1-10/2
      const [rangePart, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step in cron field: "${part}"`);

      let rangeStart = min;
      let rangeEnd = max;
      if (rangePart !== '*') {
        const [rs, re] = rangePart.split('-').map(Number);
        if (isNaN(rs) || isNaN(re)) throw new Error(`Invalid range in cron field: "${part}"`);
        rangeStart = rs;
        rangeEnd = re;
      }

      for (let i = rangeStart; i <= rangeEnd; i += step) {
        values.push(i);
      }
    } else if (part.includes('-')) {
      // Range: 1-5
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) throw new Error(`Invalid range in cron field: "${part}"`);
      for (let i = start; i <= end; i++) {
        values.push(i);
      }
    } else {
      // Single value
      const val = parseInt(part, 10);
      if (isNaN(val)) throw new Error(`Invalid value in cron field: "${part}"`);
      values.push(val);
    }
  }

  // dayOfWeek: accept 7 as a Sunday alias (==0) before range validation.
  const normalized = allowSeven ? values.map((v) => (v === 7 ? 0 : v)) : values;

  // Reject out-of-range values: an unvalidated "99" would silently never match.
  for (const v of normalized) {
    if (v < min || v > max) {
      throw new Error(`Cron field value ${v} out of range [${min},${max}]`);
    }
  }

  // Deduplicate and sort
  return [...new Set(normalized)].sort((a, b) => a - b);
}

/** Generate a range of integers [start..end] inclusive. */
function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i <= end; i++) result.push(i);
  return result;
}

/**
 * Check if a given Date matches the cron fields.
 */
function matchesCron(date: Date, fields: CronFields): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-based
  const dayOfWeek = date.getDay(); // 0 = Sunday

  if (!fields.minute.includes(minute)) return false;
  if (!fields.hour.includes(hour)) return false;
  if (!fields.dayOfMonth.includes(dayOfMonth)) return false;
  if (!fields.month.includes(month)) return false;
  if (!fields.dayOfWeek.includes(dayOfWeek)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Deterministic jitter
// ---------------------------------------------------------------------------

/**
 * Compute deterministic jitter for a recurring task.
 * Jitter = 10% of the task's period, capped at maxJitterMs.
 * Deterministic means: same task ID + same scheduled minute always produces
 * the same jitter offset, using a simple hash.
 */
function computeJitter(taskId: string, scheduledTime: Date, config: CronSchedulerConfig): number {
  // Create a seed from task ID + scheduled minute
  const seed = `${taskId}:${scheduledTime.getTime()}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }

  // Estimate the period from the cron expression. For simplicity, use 1 hour
  // as default period for sub-hourly cron, and 24 hours for daily cron.
  // The jitter fraction is applied to the estimated period.
  const estimatedPeriodMs = 60 * 60 * 1000; // 1 hour default
  const maxJitter = Math.min(
    estimatedPeriodMs * config.maxJitterFraction,
    config.maxJitterMs,
  );

  // One-sided (early-only) jitter via unsigned arithmetic. A positive offset
  // would push the fire time into a later minute that can re-match the cron
  // expression and double-fire; early-only avoids that. Unsigned (`>>> 0`)
  // also avoids the Math.abs(INT32_MIN) === INT32_MIN overflow.
  const maxJ = Math.floor(maxJitter);
  const unsigned = hash >>> 0;
  const offset = maxJ > 0 ? -(unsigned % (maxJ + 1)) : 0;
  return offset;
}

/**
 * Compute jitter for one-shot tasks.
 * If the scheduled time lands on :00 or :30, allow up to 90 seconds early.
 */
function computeOneShotJitter(taskId: string, scheduledTime: Date): number {
  const minute = scheduledTime.getMinutes();
  if (minute === 0 || minute === 30) {
    // Up to 90 seconds early
    const seed = `${taskId}:${scheduledTime.getTime()}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }
    return -(Math.abs(hash) % 90000); // 0 to -90s
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

/**
 * In-process cron scheduler with deterministic jitter, one-shot auto-delete,
 * recurring auto-expiry, and JSON persistence.
 */
export class CronScheduler {
  private readonly config: Readonly<CronSchedulerConfig>;
  private tasks: Map<string, CronTask> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly handlers: Map<string, (task: CronTask) => void | Promise<void>> = new Map();
  private parsedExpressions: Map<string, CronFields> = new Map();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private lastCheckMinute: number = -1;

  constructor(config?: Partial<CronSchedulerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Load durable tasks from disk
    this.loadTasks();

    log.info(
      { taskCount: this.tasks.size, persistencePath: this.config.persistencePath },
      'CronScheduler initialized',
    );
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Schedule a new cron task.
   *
   * @param cron   - 5-field cron expression
   * @param prompt - Prompt/callback identifier to fire
   * @param options.kind     - 'recurring' (default) or 'one-shot'
   * @param options.durable  - persist to disk (default false)
   * @param options.handler  - optional callback when task fires
   * @returns The created CronTask
   */
  schedule(
    cron: string,
    prompt: string,
    options?: {
      kind?: TaskKind;
      durable?: boolean;
      handler?: (task: CronTask) => void | Promise<void>;
    },
  ): CronTask {
    // Validate cron expression
    const fields = parseCronExpression(cron);
    const kind = options?.kind ?? 'recurring';
    const durable = options?.durable ?? false;
    const now = new Date();

    // Only recurring tasks auto-expire after recurringExpiryDays. One-shot
    // tasks must survive until their (possibly far-future) cron match fires;
    // they are auto-deleted in tick() after firing once, not by time expiry.
    const expiresAt = kind === 'recurring'
      ? new Date(
          now.getTime() + this.config.recurringExpiryDays * 24 * 60 * 60 * 1000,
        ).toISOString()
      : new Date(8640000000000000).toISOString(); // max representable Date (no time-based expiry)

    const task: CronTask = {
      id: genId(),
      cron,
      prompt,
      kind,
      createdAt: now.toISOString(),
      lastFiredAt: null,
      expiresAt,
      durable,
    };

    this.tasks.set(task.id, task);
    this.parsedExpressions.set(task.id, fields);

    if (options?.handler) {
      this.handlers.set(task.id, options.handler);
    }

    if (durable) {
      this.persistTasks();
    }

    log.info(
      { id: task.id, cron, kind, durable },
      'Task scheduled',
    );

    return task;
  }

  /**
   * Unschedule (remove) a task by its ID.
   */
  unschedule(taskId: string): boolean {
    const existed = this.tasks.delete(taskId);
    this.parsedExpressions.delete(taskId);
    this.handlers.delete(taskId);

    // Clear any pending timer
    const timer = this.timers.get(taskId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }

    if (existed) {
      this.persistTasks();
      log.info({ id: taskId }, 'Task unscheduled');
    }

    return existed;
  }

  /**
   * List all currently scheduled tasks.
   */
  listTasks(): CronTask[] {
    return [...this.tasks.values()];
  }

  /**
   * Get a specific task by ID.
   */
  getTask(taskId: string): CronTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Start the scheduler's tick loop.
   * Checks every second for cron matches and fires tasks with jitter.
   */
  start(): void {
    if (this.checkInterval !== null) return; // already running

    this.checkInterval = setInterval(() => this.tick(), 1000);
    log.info('CronScheduler tick loop started');
  }

  /**
   * Stop the scheduler's tick loop and clear all pending timers.
   */
  stop(): void {
    if (this.checkInterval !== null) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    log.info('CronScheduler tick loop stopped');
  }

  /**
   * Perform a single tick — check all tasks against current time.
   * Called automatically by start(), but can also be invoked manually for testing.
   */
  tick(): CronMatch[] {
    const now = new Date();
    const currentMinute = now.getMinutes();

    // Avoid double-firing within the same minute
    if (currentMinute === this.lastCheckMinute) {
      return [];
    }
    this.lastCheckMinute = currentMinute;

    const matches: CronMatch[] = [];
    const toDelete: string[] = [];

    for (const [id, task] of this.tasks) {
      // Check expiry
      if (new Date(task.expiresAt).getTime() <= now.getTime()) {
        toDelete.push(id);
        log.info({ id, kind: task.kind }, 'Task expired');
        continue;
      }

      const fields = this.parsedExpressions.get(id);
      if (!fields) continue;

      // Check if the previous minute would match (to handle jitter)
      // We check the current time truncated to the minute boundary
      const minuteBoundary = new Date(now);
      minuteBoundary.setSeconds(0, 0);

      if (matchesCron(minuteBoundary, fields)) {
        // Skip if we already fired this task this minute
        if (task.lastFiredAt) {
          const lastFired = new Date(task.lastFiredAt);
          if (
            lastFired.getMinutes() === minuteBoundary.getMinutes() &&
            lastFired.getHours() === minuteBoundary.getHours() &&
            lastFired.getDate() === minuteBoundary.getDate() &&
            lastFired.getMonth() === minuteBoundary.getMonth()
          ) {
            continue; // Already fired for this minute
          }
        }

        // Compute jitter
        const jitter = task.kind === 'one-shot'
          ? computeOneShotJitter(task.id, minuteBoundary)
          : computeJitter(task.id, minuteBoundary, this.config);

        const fireAt = new Date(minuteBoundary.getTime() + jitter);

        matches.push({ task, fireAt });

        // Mark as fired
        task.lastFiredAt = now.toISOString();

        // Schedule the actual callback with jitter delay
        const delayMs = fireAt.getTime() - now.getTime();
        if (delayMs <= 0) {
          // Fire immediately
          this.fireTask(task);
        } else {
          // Clear any still-pending timer for this id before overwriting the
          // map entry, otherwise the previous timer is orphaned (keeps the
          // event loop alive and cannot be cancelled by stop()).
          const existing = this.timers.get(task.id);
          if (existing !== undefined) {
            clearTimeout(existing);
          }
          const timer = setTimeout(() => {
            // Remove our own entry once we fire, but only if it still points
            // to this timer (a newer timer may have replaced it).
            if (this.timers.get(task.id) === timer) {
              this.timers.delete(task.id);
            }
            this.fireTask(task);
          }, delayMs);
          this.timers.set(task.id, timer);
        }

        // One-shot: mark for deletion after firing
        if (task.kind === 'one-shot') {
          toDelete.push(id);
        }
      }
    }

    // Remove expired and one-shot tasks
    for (const id of toDelete) {
      this.tasks.delete(id);
      this.parsedExpressions.delete(id);
      this.handlers.delete(id);
      const timer = this.timers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
    }

    if (toDelete.length > 0) {
      this.persistTasks();
    }

    return matches;
  }

  /**
   * Persist all durable tasks to disk as JSON.
   */
  persistTasks(): void {
    const durableTasks = [...this.tasks.values()].filter((t) => t.durable);
    try {
      const dir = this.config.persistencePath.substring(
        0,
        this.config.persistencePath.lastIndexOf('/'),
      );
      if (!existsSync(dir)) {
        const { mkdirSync } = require('fs');
        mkdirSync(dir, { recursive: true });
      }
      // Atomic write: a crash mid-write must not truncate the durable task file.
      // Write to a unique temp path, fsync, then rename (atomic on POSIX). 0o600
      // — task prompts are executed instructions, not world-readable.
      const tmp = `${this.config.persistencePath}.tmp.${process.pid}.${Date.now()}`;
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeSync(fd, JSON.stringify(durableTasks, null, 2), 0, 'utf-8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.config.persistencePath);
      log.debug({ count: durableTasks.length }, 'Tasks persisted to disk');
    } catch (err) {
      log.error({ path: this.config.persistencePath, err }, 'Failed to persist tasks');
    }
  }

  /**
   * Load durable tasks from disk. Detects missed tasks that should have
   * fired while the scheduler was down.
   */
  loadTasks(): { loaded: number; missed: CronTask[] } {
    if (!existsSync(this.config.persistencePath)) {
      return { loaded: 0, missed: [] };
    }

    let raw: string;
    try {
      raw = readFileSync(this.config.persistencePath, 'utf-8');
    } catch {
      return { loaded: 0, missed: [] };
    }

    let tasks: CronTask[];
    try {
      const parsed = JSON.parse(raw);
      tasks = Array.isArray(parsed) ? parsed as CronTask[] : [];
    } catch {
      log.warn({ path: this.config.persistencePath }, 'Corrupt cron-tasks.json — skipping load');
      return { loaded: 0, missed: [] };
    }

    const now = new Date();
    const missed: CronTask[] = [];
    const VALID_KINDS = new Set<TaskKind>(['recurring', 'one-shot']);
    const MAX_PROMPT_LEN = 8192;

    for (const task of tasks) {
      // Schema validation: task.prompt is a stored instruction executed by the
      // agent loop, so reject malformed/oversized records (stored-injection guard).
      if (
        !task || typeof task.id !== 'string' || task.id.length === 0 ||
        typeof task.cron !== 'string' || task.cron.length === 0 ||
        typeof task.prompt !== 'string' || task.prompt.length === 0 || task.prompt.length > MAX_PROMPT_LEN ||
        !VALID_KINDS.has(task.kind) ||
        typeof task.expiresAt !== 'string' || !Number.isFinite(new Date(task.expiresAt).getTime())
      ) {
        log.warn({ id: (task as Partial<CronTask>)?.id }, 'Invalid persisted cron task — skipping (schema validation)');
        continue;
      }

      // Skip expired tasks
      if (new Date(task.expiresAt).getTime() <= now.getTime()) {
        continue;
      }

      // Validate cron expression
      try {
        const fields = parseCronExpression(task.cron);
        this.parsedExpressions.set(task.id, fields);
      } catch {
        log.warn({ id: task.id, cron: task.cron }, 'Invalid cron expression in persisted task — skipping');
        continue;
      }

      this.tasks.set(task.id, task);

      // Detect missed tasks: if the task was last fired more than one period
      // ago (or never fired for recurring tasks), it was missed
      if (task.kind === 'recurring' && task.lastFiredAt) {
        const lastFired = new Date(task.lastFiredAt);
        const hoursSinceLastFire = (now.getTime() - lastFired.getTime()) / (1000 * 60 * 60);
        // If more than 2 hours since last fire, consider it missed
        if (hoursSinceLastFire > 2) {
          missed.push(task);
        }
      }
    }

    log.info({ loaded: this.tasks.size, missed: missed.length }, 'Tasks loaded from disk');
    return { loaded: this.tasks.size, missed };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Fire a task's handler/callback.
   */
  private fireTask(task: CronTask): void {
    const handler = this.handlers.get(task.id);
    if (handler) {
      try {
        const result = handler(task);
        if (result instanceof Promise) {
          result.catch((err) => {
            log.error({ id: task.id, err }, 'Task handler threw (async)');
          });
        }
      } catch (err) {
        log.error({ id: task.id, err }, 'Task handler threw');
      }
    }

    log.info({ id: task.id, prompt: task.prompt, kind: task.kind }, 'Task fired');
  }

  /**
   * Get the number of active tasks.
   */
  get taskCount(): number {
    return this.tasks.size;
  }

  /**
   * Check if a specific cron expression matches a given date.
   * Useful for testing without creating a full task.
   */
  testCronMatch(cron: string, date: Date): boolean {
    const fields = parseCronExpression(cron);
    return matchesCron(date, fields);
  }

  /**
   * Parse a cron expression (exposed for testing).
   */
  parseCron(expr: string): CronFields {
    return parseCronExpression(expr);
  }
}