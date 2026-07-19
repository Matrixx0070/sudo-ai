/**
 * HeartbeatRunner — periodic workspace/HEARTBEAT.md injection into the agent.
 *
 * v5 additions:
 * - Per-task intervals (parsed from YAML frontmatter in HEARTBEAT.md)
 * - HEARTBEAT_OK suppression (via heartbeat-response.ts)
 * - Light-context mode (skips full workspace injection to save tokens)
 */

import { readFileSync } from 'fs';
import path from 'path';
import { createLogger } from '../shared/logger.js';
import { PATHS, HEARTBEAT_INTERVAL_MS } from '../shared/constants.js';
import { genId } from '../shared/utils.js';
import { CronScheduler } from './scheduler.js';
import { CronStore } from './store.js';
import type { CronJob, CronPayload } from './types.js';
import { parseHour, isWithinActiveHours } from './heartbeat-hours.js';
import { getHeartbeatDueTasks, markTasksRun } from './heartbeat-tasks.js';
import {
  processHeartbeatResponse,
  type HeartbeatResponseResult,
} from './heartbeat-response.js';

const log = createLogger('cron:heartbeat');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_FILE = path.resolve(PATHS.WORKSPACE, 'HEARTBEAT.md');
const HEARTBEAT_JOB_NAME = 'system.heartbeat' as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected runner that dispatches a payload as an isolated agent turn. */
export type HeartbeatPayloadRunner = (payload: CronPayload, job: CronJob) => Promise<string | void>;

/** Options for HeartbeatRunner constructor. */
export interface HeartbeatOptions {
  /** Heartbeat interval in ms. Default: HEARTBEAT_INTERVAL_MS (30 min). */
  intervalMs?: number;
  /** IANA timezone for active hours. Reads HEARTBEAT_TIMEZONE env. Default: 'UTC'. */
  timezone?: string;
  /** Active window start hour "HH" or "HH:MM". Reads HEARTBEAT_ACTIVE_START env. */
  activeStart?: string;
  /** Active window end hour "HH" or "HH:MM". Reads HEARTBEAT_ACTIVE_END env. */
  activeEnd?: string;
  /** Model string override. Reads HEARTBEAT_MODEL env. Undefined = use primary. */
  cheapModel?: string;
  /**
   * When true the payload carries `lightContext: true`, signalling the agent
   * loop to skip full workspace injection (saves tokens).
   * Reads HEARTBEAT_LIGHT_CONTEXT env ("1" or "true"). Default: false.
   */
  lightContext?: boolean;
}

// Re-export for callers that want to type-check response results.
export type { HeartbeatResponseResult };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readHeartbeatFile(): string {
  try {
    const content = readFileSync(HEARTBEAT_FILE, 'utf8').trim();
    if (!content) return '[HEARTBEAT] No heartbeat content found.';
    return content;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '[HEARTBEAT] No heartbeat file found at workspace/HEARTBEAT.md.';
    log.error({ err, file: HEARTBEAT_FILE }, 'Failed to read HEARTBEAT.md');
    return '[HEARTBEAT] Error reading heartbeat file.';
  }
}

/**
 * Read HEARTBEAT.md raw bytes, or '' when the file is absent/unreadable.
 * (readHeartbeatFile above substitutes a placeholder on absence, which would
 * mask an empty checklist — the S5 gate needs the true raw content.)
 */
function readHeartbeatRaw(): string {
  try {
    return readFileSync(HEARTBEAT_FILE, 'utf8');
  } catch {
    return '';
  }
}

/**
 * BO4/S5: does HEARTBEAT.md carry anything ACTIONABLE this tick?
 *
 * Strips YAML frontmatter, HTML comments (`<!-- -->`), markdown/comment lines
 * (leading `#`), and whitespace. If nothing remains, the checklist is empty and
 * the tick must NOT spend a model call. Exported for unit testing.
 *
 * @param raw - Raw HEARTBEAT.md content (may be '').
 * @returns true when at least one non-comment, non-blank line survives.
 */
export function heartbeatHasActionableContent(raw: string): boolean {
  if (!raw) return false;
  let body = raw.replace(/\r\n/g, '\n');
  // Strip a leading YAML frontmatter block.
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) body = body.slice(end + 4);
  }
  // Strip HTML comments.
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  // A line is actionable only if, trimmed, it is non-empty and not a `#` line
  // (markdown header / hash comment — headers alone are not actionable work).
  return body
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l.length > 0 && !l.startsWith('#'));
}

/**
 * Build the heartbeat message injected as a user turn.
 * When `dueTaskNames` is provided, prepends a note listing which tasks are due.
 */
function buildHeartbeatMessage(dueTaskNames?: string[]): string {
  const content = readHeartbeatFile();
  const now = new Date().toISOString();

  let body = content;

  if (dueTaskNames && dueTaskNames.length > 0) {
    // Strip frontmatter block from body so agent sees clean markdown
    const normalized = content.replace(/\r\n/g, '\n');
    const frontmatterEnd = normalized.indexOf('\n---\n', 4);
    const rawBody =
      normalized.startsWith('---\n') && frontmatterEnd !== -1
        ? normalized.slice(frontmatterEnd + 5).trim()
        : content;

    body = `Due tasks this tick: ${dueTaskNames.join(', ')}\n\n${rawBody}`;
    log.debug({ dueTaskNames }, 'Heartbeat message includes due-task filter note');
  }

  return [
    `[HEARTBEAT @ ${now}]`,
    '',
    body,
    '',
    '---',
    'This is an automated heartbeat. Review the above and take any necessary',
    'autonomous actions based on outstanding TODOs or pending tasks.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// HeartbeatRunner
// ---------------------------------------------------------------------------

export class HeartbeatRunner {
  private readonly store: CronStore;
  private readonly scheduler: CronScheduler;
  private readonly intervalMs: number;
  private readonly timezone: string;
  private readonly activeStart: number | null;
  private readonly activeEnd: number | null;
  readonly cheapModel: string | undefined;
  readonly lightContext: boolean;
  private jobId: string | null = null;
  private running = false;

  constructor(store: CronStore, scheduler: CronScheduler, options: HeartbeatOptions = {}) {
    if (!store) throw new TypeError('HeartbeatRunner: store must be provided');
    if (!scheduler) throw new TypeError('HeartbeatRunner: scheduler must be provided');

    const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    if (typeof intervalMs !== 'number' || intervalMs < 1_000) {
      throw new RangeError('HeartbeatRunner: intervalMs must be a number >= 1000');
    }

    this.store = store;
    this.scheduler = scheduler;
    this.intervalMs = intervalMs;
    this.timezone = options.timezone ?? process.env['HEARTBEAT_TIMEZONE'] ?? 'UTC';
    this.activeStart = parseHour(options.activeStart ?? process.env['HEARTBEAT_ACTIVE_START']);
    this.activeEnd = parseHour(options.activeEnd ?? process.env['HEARTBEAT_ACTIVE_END']);
    this.cheapModel = options.cheapModel ?? process.env['HEARTBEAT_MODEL'] ?? undefined;

    const envLight = process.env['HEARTBEAT_LIGHT_CONTEXT'];
    this.lightContext = options.lightContext ?? (envLight === '1' || envLight === 'true');

    log.debug(
      { timezone: this.timezone, activeStart: this.activeStart, activeEnd: this.activeEnd, cheapModel: this.cheapModel, lightContext: this.lightContext },
      'HeartbeatRunner configured',
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Register and activate the heartbeat cron job. Idempotent. */
  start(): void {
    if (this.running) {
      log.warn('HeartbeatRunner.start called while already running — ignoring');
      return;
    }

    this._removeExisting();

    const { dueNames } = getHeartbeatDueTasks(HEARTBEAT_FILE, PATHS.WORKSPACE);

    const payload: CronPayload = {
      kind: 'agentTurn',
      message: buildHeartbeatMessage(dueNames.length > 0 ? dueNames : undefined),
      ...(this.cheapModel ? { model: this.cheapModel } : {}),
      ...(this.lightContext ? { lightContext: true } : {}),
    };

    const job = this.scheduler.addJob({
      id: genId(),
      name: HEARTBEAT_JOB_NAME,
      schedule: { kind: 'every', ms: this.intervalMs },
      payload,
      sessionTarget: 'isolated',
      enabled: true,
      consecutiveErrors: 0,
    });

    this.jobId = job.id;
    this.running = true;

    log.info(
      { jobId: this.jobId, intervalMs: this.intervalMs, lightContext: this.lightContext },
      'HeartbeatRunner started',
    );
  }

  /** Deactivate and remove the heartbeat cron job. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this._removeExisting();
    this.jobId = null;
    this.running = false;
    log.info('HeartbeatRunner stopped');
  }

  get isRunning(): boolean { return this.running; }

  isActiveNow(): boolean {
    return isWithinActiveHours(new Date(), this.timezone, this.activeStart, this.activeEnd);
  }

  /** Read HEARTBEAT.md and return the formatted message (no scheduling). */
  readNow(): string {
    const { dueNames } = getHeartbeatDueTasks(HEARTBEAT_FILE, PATHS.WORKSPACE);
    const msg = buildHeartbeatMessage(dueNames.length > 0 ? dueNames : undefined);
    log.debug({ msgLen: msg.length }, 'Heartbeat message read on demand');
    return msg;
  }

  // -------------------------------------------------------------------------
  // HEARTBEAT_OK suppression (Feature 2)
  // -------------------------------------------------------------------------

  /**
   * Process an agent response to decide if it should be suppressed.
   * Delegates to heartbeat-response.ts processHeartbeatResponse().
   */
  static processResponse(response: string): HeartbeatResponseResult {
    return processHeartbeatResponse(response);
  }

  /**
   * @deprecated Use processResponse() for richer suppression logic.
   */
  static isSilentAck(response: string): boolean {
    return HeartbeatRunner.processResponse(response).suppress;
  }

  // -------------------------------------------------------------------------
  // Wrap runner (quiet hours + per-task filter + OK suppression)
  // -------------------------------------------------------------------------

  /**
   * Wrap a HeartbeatPayloadRunner with:
   * 1. Quiet-hours gate — skip outside active window
   * 2. Per-task due-task filtering — only fire tasks whose interval has elapsed
   * 3. HEARTBEAT_OK suppression — return void when agent signals all-clear
   */
  wrapRunner(baseRunner: HeartbeatPayloadRunner): HeartbeatPayloadRunner {
    if (typeof baseRunner !== 'function') {
      throw new TypeError('HeartbeatRunner.wrapRunner: baseRunner must be a function');
    }

    return async (payload: CronPayload, job: CronJob): Promise<string | void> => {
      // Gate 1: quiet hours
      if (!this.isActiveNow()) {
        log.debug({ jobId: job.id }, 'Heartbeat skipped — outside active hours');
        return;
      }

      // Gate 1.5 (BO4/S5): empty checklist ⇒ no model call. When HEARTBEAT.md is
      // absent, blank, or comments/headers-only, there is nothing actionable to
      // run — skip the model call entirely rather than pay for a HEARTBEAT_OK.
      if (!heartbeatHasActionableContent(readHeartbeatRaw())) {
        log.info({ jobId: job.id }, 'heartbeat: empty checklist — skipping model call');
        return;
      }

      // Gate 2: per-task due filter
      const now = new Date();
      const { tasks, dueNames, state } = getHeartbeatDueTasks(HEARTBEAT_FILE, PATHS.WORKSPACE, now);

      if (tasks.length > 0 && dueNames.length === 0) {
        log.debug({ jobId: job.id }, 'Heartbeat skipped — no tasks due this tick');
        return;
      }

      // Build live payload with fresh message and lightContext flag
      let livePayload = payload;
      if (payload.kind === 'agentTurn') {
        livePayload = {
          ...payload,
          message: buildHeartbeatMessage(dueNames.length > 0 ? dueNames : undefined),
          ...(this.lightContext ? { lightContext: true } : {}),
        };
      }

      const rawResponse = await baseRunner(livePayload, job);

      // Update task timestamps after successful dispatch
      if (tasks.length > 0 && dueNames.length > 0) {
        markTasksRun(PATHS.WORKSPACE, state, dueNames, now);
      }

      // Gate 3: HEARTBEAT_OK suppression
      if (typeof rawResponse === 'string') {
        const result = HeartbeatRunner.processResponse(rawResponse);
        if (result.suppress) {
          log.debug({ jobId: job.id }, 'Heartbeat response suppressed (HEARTBEAT_OK)');
          return;
        }
        return result.content ?? rawResponse;
      }

      return rawResponse;
    };
  }

  // -------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------

  /** Update the heartbeat job message with fresh HEARTBEAT.md + due-task list. */
  refreshJobMessage(): void {
    if (!this.jobId) {
      log.warn('HeartbeatRunner.refreshJobMessage: no active job — ignoring');
      return;
    }

    const { dueNames } = getHeartbeatDueTasks(HEARTBEAT_FILE, PATHS.WORKSPACE);
    const fresh = buildHeartbeatMessage(dueNames.length > 0 ? dueNames : undefined);

    const patchPayload: CronPayload = {
      kind: 'agentTurn',
      message: fresh,
      ...(this.cheapModel ? { model: this.cheapModel } : {}),
      ...(this.lightContext ? { lightContext: true } : {}),
    };

    this.store.patch(this.jobId, { payload: patchPayload });
    log.debug({ jobId: this.jobId, msgLen: fresh.length }, 'Heartbeat job message refreshed');
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _removeExisting(): void {
    if (this.jobId) {
      this.scheduler.removeJob(this.jobId);
      return;
    }
    const existing = this.store.list().find((j) => j.name === HEARTBEAT_JOB_NAME);
    if (existing) {
      this.scheduler.removeJob(existing.id);
      log.debug({ jobId: existing.id }, 'Removed stale heartbeat job by name');
    }
  }
}
