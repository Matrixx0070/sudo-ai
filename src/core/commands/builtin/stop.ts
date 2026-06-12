/**
 * @file builtin/stop.ts
 * @description /stop — discard the in-flight reply for this conversation.
 *
 * Bumps the conversation's run generation so any turn currently executing
 * has its reply discarded at the stale-check before send. The model call
 * itself is not aborted mid-flight; session history is kept (unlike /reset,
 * which also archives the session).
 */

import { createLogger } from '../../shared/index.js';
import { runGenerations } from '../../sessions/run-generation.js';
import type { SlashCommand, CommandContext } from '../types.js';

const log = createLogger('commands:stop');

export const stopCommand: SlashCommand = {
  name: 'stop',
  description: 'Discard the in-flight reply for this conversation (history is kept).',
  usage: '/stop',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    const key = `${ctx.channel}:${ctx.peerId}`;
    const generation = runGenerations.bump(key);
    log.info({ key, generation }, '/stop — run generation bumped, in-flight reply will be discarded');
    return [
      'Stop signal sent.',
      'Any reply currently being generated for this conversation will be discarded when it finishes (the model call is not aborted mid-flight).',
      'Conversation history is kept — use /reset to also start a fresh session.',
    ].join('\n');
  },
};
