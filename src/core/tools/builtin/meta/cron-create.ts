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

/** 5-field cron expression validator — each field must be *, digits, ranges, steps, or lists. */
const FIELD_RE = /^(\*|[0-9,\-\/\*]+)$/;
function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every(f => FIELD_RE.test(f));
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
      const result = await cronManager.addJob({ expression: expression.trim(), name: name.trim(), message: message.trim() });
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
