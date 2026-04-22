/**
 * @file builtin/produce.ts
 * @description /produce [topic] — triggers the video pipeline for a given topic.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:produce');

export const produceCommand: SlashCommand = {
  name: 'produce',
  description: 'Trigger the video pipeline for a topic.',
  usage: '/produce [topic]',

  async execute(args: string, ctx: CommandContext): Promise<string> {
    const topic = args.trim();

    if (!topic) {
      return 'Usage: /produce [topic]\nExample: /produce AI vs humans 2026';
    }

    log.info({ peerId: ctx.peerId, topic }, '/produce triggered');

    // Attempt to call pipeline orchestrator if present on the agentLoop context.
    // The tool 'pipeline.start' is invoked when the registry exposes it.
    const registry = ctx.toolRegistry as {
      isEnabled?: (name: string) => boolean;
      execute?: (
        name: string,
        params: Record<string, unknown>,
        ctx: unknown,
      ) => Promise<{ success: boolean; output: string }>;
    } | null;

    if (registry?.isEnabled?.('pipeline.start') && registry.execute) {
      try {
        const result = await registry.execute(
          'pipeline.start',
          { topic },
          { sessionId: ctx.sessionId, workingDir: process.cwd(), config: ctx.config, logger: log },
        );
        log.info({ topic, success: result.success }, 'Pipeline tool called');
        return result.output;
      } catch (err) {
        log.error({ topic, err }, 'Pipeline tool call failed');
        return `Pipeline failed to start: ${String(err)}`;
      }
    }

    // Graceful fallback when the pipeline tool is not loaded
    log.warn({ topic }, 'pipeline.start tool not available — returning acknowledgement');
    return `Pipeline queued for: ${topic}\n(pipeline.start tool not loaded — task logged)`;
  },
};
