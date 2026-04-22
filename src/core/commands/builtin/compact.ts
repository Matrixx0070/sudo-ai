/**
 * @file builtin/compact.ts
 * @description /compact — forces context compaction on the current session.
 */

import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:compact');

interface SessionManagerLike {
  get: (sessionId: string) => Promise<{ messages: unknown[] } | undefined>;
  save: (session: unknown) => Promise<void>;
}

interface BrainLike {
  call: (req: unknown) => Promise<unknown>;
}

interface AgentLoopLike {
  brain?: BrainLike;
  sessionManager?: SessionManagerLike;
}

export const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'Force context compaction on the current session.',
  usage: '/compact',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    log.info({ sessionId: ctx.sessionId, peerId: ctx.peerId }, '/compact triggered');

    const loop = ctx.agentLoop as AgentLoopLike | null;
    const sessionManager = loop?.sessionManager;
    const brain = loop?.brain;

    if (!sessionManager || !brain) {
      log.warn({ sessionId: ctx.sessionId }, '/compact: agentLoop or brain not available');
      return 'Compaction not available: agent loop is not connected to this context.';
    }

    let session: { messages: unknown[] } | undefined;
    try {
      session = await sessionManager.get(ctx.sessionId);
    } catch (err) {
      log.error({ sessionId: ctx.sessionId, err }, '/compact: failed to load session');
      return `Failed to load session: ${String(err)}`;
    }

    if (!session) {
      return `Session not found: ${ctx.sessionId}`;
    }

    const before = session.messages.length;

    try {
      // Dynamic import to avoid circular deps at top-level
      const { compact } = await import('../../agent/compaction.js');
      const summary = await compact(brain, session.messages as Array<{ role: string; content: string }>);

      session.messages = [
        { role: 'system', content: `[Context compacted]\n\n${summary}` },
      ];

      await sessionManager.save(session);
      log.info({ sessionId: ctx.sessionId, before, after: 1 }, '/compact completed');
      return `Context compacted.\nBefore: ${before} messages\nAfter: 1 summary message\nSummary length: ${summary.length} chars`;
    } catch (err) {
      log.error({ sessionId: ctx.sessionId, err }, '/compact: compaction failed');
      return `Compaction failed: ${String(err)}`;
    }
  },
};
