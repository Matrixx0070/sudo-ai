/**
 * @file builtin/reset.ts
 * @description /reset — archive the current session and start a fresh one.
 */

import { createLogger } from '../../shared/index.js';
import { runGenerations } from '../../sessions/run-generation.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:reset');

interface SessionManagerLike {
  archive: (sessionId: string) => Promise<void>;
  getOrCreate: (channel: string, peerId: string) => Promise<{ id: string }>;
}

interface AgentLoopLike {
  sessionManager?: SessionManagerLike;
}

export const resetCommand: SlashCommand = {
  name: 'reset',
  description: 'Archive the current session and start a fresh conversation.',
  usage: '/reset',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    log.info({ sessionId: ctx.sessionId, peerId: ctx.peerId }, '/reset triggered');

    const loop = ctx.agentLoop as AgentLoopLike | null;
    const sessionManager = loop?.sessionManager;

    if (!sessionManager) {
      log.warn({ sessionId: ctx.sessionId }, '/reset: sessionManager not available');
      return 'Reset not available: session manager is not connected to this context.';
    }

    const oldId = ctx.sessionId;

    try {
      await sessionManager.archive(oldId);
      log.info({ oldId }, 'Session archived');
      // Invalidate any in-flight turn for this conversation so its stale
      // reply is discarded instead of being delivered after the reset.
      const generation = runGenerations.bump(`${ctx.channel}:${ctx.peerId}`);
      log.info({ channel: ctx.channel, peerId: ctx.peerId, generation }, 'Run generation bumped — in-flight turns invalidated');
    } catch (err) {
      log.error({ oldId, err }, '/reset: failed to archive session');
      return `Failed to archive session: ${String(err)}`;
    }

    try {
      const newSession = await sessionManager.getOrCreate(ctx.channel as 'telegram', ctx.peerId);
      log.info({ newSessionId: newSession.id }, 'New session created after reset');
      return `Session reset complete.\nOld session: ${oldId} (archived)\nNew session: ${newSession.id}`;
    } catch (err) {
      log.error({ err }, '/reset: failed to create new session');
      return `Session archived but failed to create new session: ${String(err)}`;
    }
  },
};
