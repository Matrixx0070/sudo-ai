import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('custom.ping');

/**
 * Returns "pong" with current ISO timestamp.
 * No parameters required.
 */
export const custom_pingTool: ToolDefinition = {
  name: 'custom.ping',
  description: 'Returns pong with current ISO timestamp. No parameters.',
  category: 'meta' as const,
  timeout: 30_000,
  parameters: {},
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    logger.info({ session: ctx.sessionId }, 'custom.ping invoked');
    try {
      // Validate no unexpected parameters
      if (Object.keys(params).length > 0) {
        throw new Error(`Expected no parameters, received: ${JSON.stringify(Object.keys(params))}`);
      }

      const timestamp = new Date().toISOString();
      const result = `pong ${timestamp}`;

      logger.info({ session: ctx.sessionId, timestamp }, 'custom.ping success');
      return { success: true, output: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, session: ctx.sessionId }, 'custom.ping error');
      return { success: false, output: `Error: ${msg}` };
    }
  },
};