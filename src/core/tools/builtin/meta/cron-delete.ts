/**
 * meta.cron.delete — Remove a scheduled cron job by name.
 *
 * Delegates to the injected cronManager dependency. Returns a graceful
 * not-initialised message when the manager has not been injected.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { getCronManager } from './index.js';

const logger = createLogger('meta.cron.delete');

// ---------------------------------------------------------------------------
// CronManager interface (duck-typed)
// ---------------------------------------------------------------------------

interface CronRemoveResult {
  name: string;
  removed: boolean;
  [key: string]: unknown;
}

interface CronManagerLike {
  removeJob(name: string): Promise<CronRemoveResult>;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const cronDeleteTool: ToolDefinition = {
  name: 'cron.delete',
  description:
    'Delete a scheduled cron job by its name. ' +
    'Use this to cancel a recurring task that was previously created with cron.create.',
  category: 'meta',
  timeout: 15_000,
  parameters: {
    name: {
      type: 'string',
      required: true,
      description: 'Name of the cron job to delete. Must exactly match the name used when creating the job.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = params['name'] as string | undefined;

    logger.info({ session: ctx.sessionId, name }, 'cron.delete invoked');

    if (!name?.trim()) {
      return { success: false, output: 'cron.delete: "name" parameter is required and must be non-empty.' };
    }

    const cronManager = getCronManager() as CronManagerLike | null;
    if (!cronManager) {
      logger.warn({ session: ctx.sessionId }, 'cron.delete: cronManager not initialised');
      return {
        success: false,
        output: 'cron.delete: cron manager has not been initialised. Call injectMetaToolDeps() with a cronManager before using this tool.',
      };
    }

    try {
      const result = await cronManager.removeJob(name.trim());

      if (!result.removed) {
        logger.warn({ session: ctx.sessionId, name: name.trim() }, 'cron.delete: job not found');
        return {
          success: false,
          output: `cron.delete: no cron job found with name "${name.trim()}". Use meta.cron-manager to list active jobs.`,
          data: result,
        };
      }

      logger.info({ session: ctx.sessionId, name: name.trim() }, 'Cron job deleted');
      return {
        success: true,
        output: `Cron job "${name.trim()}" deleted successfully.`,
        data: result,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ session: ctx.sessionId, name, err: msg }, 'cron.delete error');
      return { success: false, output: `cron.delete error: ${msg}` };
    }
  },
};
