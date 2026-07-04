/**
 * meta.cron.create — Schedule a recurring agent task using a cron expression.
 *
 * Delegates to the injected cronManager dependency. Returns a graceful
 * not-initialised message when the manager has not been injected.
 *
 * The cron expression follows standard 5-field POSIX syntax:
 *   ┌──────────── minute (0-59)
 *   │ ┌────────── hour (0-23)
 *   │ │ ┌──────── day of month (1-31)
 *   │ │ │ ┌────── month (1-12)
 *   │ │ │ │ ┌──── day of week (0-7, Sunday=0 or 7)
 *   │ │ │ │ │
 *   * * * * *
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { getCronManager } from './index.js';
import { withCommsIdempotency } from '../../../comms/idempotency.js';

const logger = createLogger('meta.cron.create');

// ---------------------------------------------------------------------------
// CronManager interface (duck-typed)
// ---------------------------------------------------------------------------

interface CronJobOptions {
  expression: string;
  name: string;
  message: string;
}

interface CronAddResult {
  jobId?: string;
  name: string;
  expression: string;
  nextRun?: string;
  [key: string]: unknown;
}

interface CronManagerLike {
  addJob(opts: CronJobOptions): Promise<CronAddResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 5-field cron expression validator. Each field must be a `*`, a single value,
 * a range (`a-b`), a step (`*\/n` or `a-b/n`), or a comma-separated list of the
 * above — with all numeric values constrained to that field's valid range. This
 * mirrors the range-aware validation performed by the cron manager so obviously
 * impossible schedules (e.g. minute 60, hour 24, step 0) are rejected up front
 * rather than silently installed as a job that never fires as intended.
 */
const FIELD_RANGES: ReadonlyArray<{ min: number; max: number }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day-of-week (0 and 7 both = Sunday)
];

function isValidNumber(part: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(part)) return false;
  const val = Number.parseInt(part, 10);
  return val >= min && val <= max;
}

function isValidRangeOrValue(part: string, min: number, max: number): boolean {
  const rangeMatch = part.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const lo = Number.parseInt(rangeMatch[1]!, 10);
    const hi = Number.parseInt(rangeMatch[2]!, 10);
    return lo >= min && hi <= max && lo <= hi;
  }
  return isValidNumber(part, min, max);
}

function isValidFieldPart(part: string, min: number, max: number): boolean {
  if (part === '*') return true;

  // Step values: */n or a-b/n
  const stepMatch = part.match(/^(.+)\/(\d+)$/);
  if (stepMatch) {
    const base = stepMatch[1]!;
    const step = Number.parseInt(stepMatch[2]!, 10);
    if (step < 1) return false;
    return base === '*' || isValidRangeOrValue(base, min, max);
  }

  return isValidRangeOrValue(part, min, max);
}

function isValidField(field: string, min: number, max: number): boolean {
  const parts = field.split(',');
  // Reject empty tokens produced by malformed lists such as ",,," or "1,".
  return parts.length > 0 && parts.every(p => p.length > 0 && isValidFieldPart(p, min, max));
}

function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => {
    const range = FIELD_RANGES[i]!;
    return isValidField(field, range.min, range.max);
  });
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const cronCreateTool: ToolDefinition = {
  name: 'cron.create',
  description:
    'Schedule a recurring task using a cron expression. The task will trigger the agent with the provided message on the given schedule. ' +
    'Use this to automate recurring jobs, reminders, reports, or monitoring tasks.',
  category: 'meta',
  timeout: 15_000,
  parameters: {
    expression: {
      type: 'string',
      required: true,
      description:
        'Standard 5-field cron expression defining the schedule. Examples: "0 9 * * 1-5" (weekdays at 9am), "*/30 * * * *" (every 30 minutes), "0 0 * * 0" (every Sunday midnight).',
    },
    name: {
      type: 'string',
      required: true,
      description: 'Unique human-readable name for this cron job (used to identify and delete it later).',
    },
    message: {
      type: 'string',
      required: true,
      description: 'The task instruction or message that will be sent to the agent each time this job fires.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const expression = params['expression'] as string | undefined;
    const name = params['name'] as string | undefined;
    const message = params['message'] as string | undefined;

    logger.info({ session: ctx.sessionId, name, expression }, 'cron.create invoked');

    if (!expression?.trim()) {
      return { success: false, output: 'cron.create: "expression" parameter is required and must be non-empty.' };
    }
    if (!name?.trim()) {
      return { success: false, output: 'cron.create: "name" parameter is required and must be non-empty.' };
    }
    if (!message?.trim()) {
      return { success: false, output: 'cron.create: "message" parameter is required and must be non-empty.' };
    }

    if (!isValidCronExpression(expression)) {
      return {
        success: false,
        output: `cron.create: invalid cron expression "${expression}". Expected 5 space-separated fields (minute hour day month weekday).`,
      };
    }

    const cronManager = getCronManager() as CronManagerLike | null;
    if (!cronManager) {
      logger.warn({ session: ctx.sessionId }, 'cron.create: cronManager not initialised');
      return {
        success: false,
        output: 'cron.create: cron manager has not been initialised. Call injectMetaToolDeps() with a cronManager before using this tool.',
      };
    }

    try {
      // Idempotency (opt-in): a re-dispatched turn must not create a SECOND cron
      // job with the same name+schedule+message. Keyed on all three so editing any
      // of them is a genuinely new job, not a suppressed duplicate.
      const guard = await withCommsIdempotency(
        { channel: 'cron', recipient: name.trim(), body: `${expression.trim()}\n${message.trim()}` },
        () => cronManager.addJob({ expression: expression.trim(), name: name.trim(), message: message.trim() }),
        (r) => r.jobId,
      );
      if (guard.duplicate) {
        return {
          success: true,
          output: `cron.create: duplicate suppressed — a cron job "${name.trim()}" with the same schedule and message was already created within the idempotency window.${guard.messageId ? ` Prior job ID: ${guard.messageId}.` : ''}`,
          data: { name: name.trim(), duplicate: true, jobId: guard.messageId },
        };
      }
      const result = guard.result!;
      logger.info({ session: ctx.sessionId, name: name.trim(), expression: expression.trim(), jobId: result.jobId }, 'Cron job created');

      const nextNote = result.nextRun ? `\nNext run: ${result.nextRun}` : '';
      const idNote = result.jobId ? ` (job ID: ${result.jobId})` : '';
      return {
        success: true,
        output: `Cron job "${name.trim()}" created${idNote}.\nSchedule: ${expression.trim()}${nextNote}`,
        data: result,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ session: ctx.sessionId, name, expression, err: msg }, 'cron.create error');
      return { success: false, output: `cron.create error: ${msg}` };
    }
  },
};
