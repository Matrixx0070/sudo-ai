/**
 * Type definitions for the SUDO-AI cron / scheduler module.
 *
 * Cron jobs are persisted to data/cron/jobs.json and evaluated by the
 * CronScheduler on a 1-second tick using the `croner` library.
 */

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing when a job should fire.
 *
 * - `at`    — fires once at a specific ISO datetime.
 * - `every` — fires on a fixed millisecond interval.
 * - `cron`  — fires on a standard 5/6-field cron expression with timezone.
 */
export type CronSchedule =
  | { kind: 'at'; datetime: string }
  | { kind: 'every'; ms: number }
  | { kind: 'cron'; expr: string; tz: string };

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing what a job does when it fires.
 *
 * - `systemEvent` — publishes a named internal event to the event bus.
 * - `agentTurn`   — injects a user-facing message into an agent session.
 */
export type CronPayload =
  | { kind: 'systemEvent'; event: string }
  | {
      kind: 'agentTurn';
      message: string;
      model?: string;
      /**
       * When true the agent loop should skip full workspace injection for this
       * turn (saves tokens). Only HEARTBEAT.md content is included.
       * Default: false.
       */
      lightContext?: boolean;
    };

// ---------------------------------------------------------------------------
// Job definition
// ---------------------------------------------------------------------------

/**
 * A persistent cron job definition stored in data/cron/jobs.json.
 */
export interface CronJob {
  /** Unique nanoid for this job. */
  id: string;
  /** Human-readable name shown in logs and status output. */
  name: string;
  /** When the job fires. */
  schedule: CronSchedule;
  /** What happens when the job fires. */
  payload: CronPayload;
  /**
   * Which session context the job runs in.
   * - `main`     — appended to the persistent main session.
   * - `isolated` — runs in a sandboxed, throw-away session.
   */
  sessionTarget: 'main' | 'isolated';
  /** Whether this job is currently active. Disabled jobs are stored but skipped. */
  enabled: boolean;
  /** ISO timestamp of the last successful run. */
  lastRun?: string;
  /** Number of consecutive failed runs since the last success. */
  consecutiveErrors: number;
}

// ---------------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------------

/**
 * A single run log entry appended to data/cron/runs.jsonl.
 * Written after every job execution regardless of success or failure.
 */
export interface CronRunRecord {
  /** Unique nanoid for this run record. */
  id: string;
  /** Name of the job that ran (denormalised for readability). */
  jobName: string;
  /** ISO timestamp when the run started. */
  ranAt: string;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** True if the job completed without throwing. */
  success: boolean;
  /** Error message, populated only when success === false. */
  error?: string;
}
