/**
 * @file operators/operator-scheduler.ts
 * @description Schedules loaded OperatorManifest entries via interval or cron.
 *
 * Design:
 *   - interval operators: setInterval with value (seconds) × 1000
 *   - cron operators: best-effort next-fire calculation (no external dep)
 *     Uses a simple cron-to-ms-until-next helper for common patterns.
 *   - Does NOT edit heartbeat-tasks.ts — registers via callback at bootstrap.
 *
 * Usage:
 *   const scheduler = new OperatorScheduler(onFireCallback);
 *   scheduler.registerAll(manifests);
 *   // ...on shutdown:
 *   scheduler.shutdown();
 */

import { createLogger } from '../shared/logger.js';
import type { OperatorManifest } from '../shared/wave10-types.js';
import type { OperatorFireCallback, ScheduledOperator } from './operator-types.js';

const log = createLogger('operators:scheduler');

// ---------------------------------------------------------------------------
// Cron helpers — covers "minute", "hourly", "daily", "weekly" patterns
// without adding a dep. Cron expressions with wildcards only.
// ---------------------------------------------------------------------------

/**
 * Compute approximate milliseconds until the next cron fire for simple
 * cron expressions. Handles: * * * * * patterns only (minute-level).
 *
 * For complex cron, falls back to 60-minute interval and logs a warning.
 *
 * @param cron - Cron expression, e.g. "0 9 * * *".
 * @returns Milliseconds until next fire.
 */
function msUntilNextCron(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    log.warn({ cron }, 'Non-5-field cron expression — defaulting to 60-minute interval');
    return 60 * 60 * 1000;
  }

  const now = new Date();
  const [minutePart, hourPart, , , dowPart] = parts;

  // Determine target hour and minute. A wildcard minute means "every minute"
  // (within the constraints of the hour field), so -1 signals that mode.
  const targetMinute = minutePart === '*' ? -1 : parseInt(minutePart ?? '0', 10);
  const targetHour = hourPart === '*' ? -1 : parseInt(hourPart ?? '0', 10);
  // Day-of-week constraint (0-6, Sunday=0). -1 means unconstrained.
  const targetDow = dowPart === '*' ? -1 : parseInt(dowPart ?? '0', 10);

  const next = new Date(now);
  next.setSeconds(0, 0);

  if (targetMinute < 0 && targetHour < 0) {
    // Every-minute pattern (* * * * *) — fire at the top of the next minute.
    next.setMinutes(next.getMinutes() + 1, 0, 0);
  } else if (targetHour >= 0) {
    // Daily or weekly — find next occurrence of that hour:minute.
    next.setHours(targetHour, isNaN(targetMinute) || targetMinute < 0 ? 0 : targetMinute, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    // If a day-of-week constraint is present, advance day-by-day until it matches.
    if (targetDow >= 0 && targetDow <= 6) {
      while (next.getDay() !== targetDow || next <= now) {
        next.setDate(next.getDate() + 1);
      }
    }
  } else {
    // Every-hour pattern — find next occurrence of that minute.
    next.setMinutes(isNaN(targetMinute) || targetMinute < 0 ? 0 : targetMinute, 0, 0);
    if (next <= now) {
      next.setHours(next.getHours() + 1);
    }
  }

  return Math.max(next.getTime() - now.getTime(), 1000);
}

/**
 * Compute repeat interval for cron (period of the expression).
 * Returns ms between fires after the first fire.
 */
function cronRepeatMs(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 60 * 60 * 1000;

  const [minutePart, hourPart, , , dowPart] = parts;

  if (minutePart === '*' && hourPart === '*') return 60 * 1000;   // every minute
  if (hourPart === '*') return 60 * 60 * 1000;                     // every hour
  if (dowPart !== '*') return 7 * 24 * 60 * 60 * 1000;            // weekly (day-of-week pinned)
  return 24 * 60 * 60 * 1000;                                     // every day
}

// ---------------------------------------------------------------------------
// OperatorScheduler
// ---------------------------------------------------------------------------

export class OperatorScheduler {
  private readonly scheduled: ScheduledOperator[] = [];
  private readonly onFire: OperatorFireCallback;

  /**
   * @param onFire - Callback invoked each time a scheduled operator fires.
   */
  constructor(onFire: OperatorFireCallback) {
    this.onFire = onFire;
  }

  /**
   * Register all enabled operators from the provided manifests.
   * Disabled operators are skipped (logged at debug level).
   *
   * @param manifests - Array of loaded OperatorManifest objects.
   */
  registerAll(manifests: OperatorManifest[]): void {
    for (const manifest of manifests) {
      if (!manifest.enabled) {
        log.debug({ name: manifest.name }, 'Operator disabled — skipping');
        continue;
      }
      this.register(manifest);
    }
    log.info(
      { total: manifests.length, active: this.scheduled.length },
      'Operator scheduling complete',
    );
  }

  /**
   * Register a single operator for scheduled execution.
   */
  register(manifest: OperatorManifest): void {
    const { schedule } = manifest;
    let handle: ReturnType<typeof setInterval>;

    if (schedule.type === 'interval') {
      const intervalSec = typeof schedule.value === 'number'
        ? schedule.value
        : parseInt(String(schedule.value), 10);

      if (isNaN(intervalSec) || intervalSec <= 0) {
        log.error({ name: manifest.name, value: schedule.value }, 'Invalid interval value — skipping operator');
        return;
      }

      const intervalMs = intervalSec * 1000;
      handle = setInterval(() => this.fireOperator(manifest), intervalMs);
      log.info({ name: manifest.name, intervalSec }, 'Operator registered (interval)');

    } else {
      // cron type
      const cron = String(schedule.value);
      const firstFireMs = msUntilNextCron(cron);
      const repeatMs = cronRepeatMs(cron);

      // Use setTimeout → setInterval chain for accurate first-fire timing
      let cronHandle: ReturnType<typeof setInterval>;
      const timeoutHandle = setTimeout(() => {
        this.fireOperator(manifest);
        cronHandle = setInterval(() => this.fireOperator(manifest), repeatMs);
        // Replace the handle in scheduled list
        const entry = this.scheduled.find((s) => s.manifest.name === manifest.name);
        if (entry) {
          clearInterval(entry.handle);
          entry.handle = cronHandle;
        }
      }, firstFireMs);

      // Store a dummy handle that we'll replace; clearInterval on dummy is a no-op
      cronHandle = timeoutHandle as unknown as ReturnType<typeof setInterval>;
      handle = cronHandle;

      log.info(
        { name: manifest.name, cron, firstFireMs: Math.round(firstFireMs / 1000) + 's' },
        'Operator registered (cron)',
      );
    }

    this.scheduled.push({ manifest, handle });
  }

  /**
   * Stop all scheduled operators and clear timers.
   */
  shutdown(): void {
    for (const entry of this.scheduled) {
      clearInterval(entry.handle);
    }
    this.scheduled.length = 0;
    log.info('Operator scheduler shut down');
  }

  /** Return count of currently active scheduled operators. */
  get count(): number {
    return this.scheduled.length;
  }

  /** Return snapshot of active operator names. */
  activeNames(): string[] {
    return this.scheduled.map((s) => s.manifest.name);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private fireOperator(manifest: OperatorManifest): void {
    log.info({ name: manifest.name }, 'Operator firing');
    try {
      const result = this.onFire(manifest);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ name: manifest.name, err: msg }, 'Operator fire callback error');
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ name: manifest.name, err: msg }, 'Operator fire callback threw synchronously');
    }
  }
}
