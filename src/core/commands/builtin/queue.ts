/**
 * @file builtin/queue.ts
 * @description /queue — inspect the per-peer turn queue.
 *
 * Reads the KeyedAsyncQueue exposed via CommandContext.peerQueue. The queue
 * tracks one task chain per key (not a depth count), so the report shows
 * which peers have active work and whether this conversation is busy.
 */

import type { SlashCommand, CommandContext } from '../types.js';

interface PeerQueueLike {
  pendingKeys: string[];
  size: number;
}

function isPeerQueueLike(q: unknown): q is PeerQueueLike {
  return (
    typeof q === 'object' && q !== null &&
    Array.isArray((q as PeerQueueLike).pendingKeys) &&
    typeof (q as PeerQueueLike).size === 'number'
  );
}

export const queueCommand: SlashCommand = {
  name: 'queue',
  description: 'Show the turn queue state (active peers, whether this chat is busy).',
  usage: '/queue',

  async execute(_args: string, ctx: CommandContext): Promise<string> {
    const q = ctx.peerQueue;
    if (!isPeerQueueLike(q)) {
      return 'Queue inspection is not available in this context.';
    }

    // cli.ts handlers enqueue under the bare peerId; the MessageRouter uses
    // `${channel}:${peerId}` on its own internal queue — check both keys.
    const busy = q.pendingKeys.includes(ctx.peerId) || q.pendingKeys.includes(`${ctx.channel}:${ctx.peerId}`);

    return [
      'Turn Queue',
      '==========',
      `Peers with active work : ${q.size}`,
      `This conversation      : ${busy ? 'busy (a turn is queued or running)' : 'idle'}`,
      '',
      'Note: each peer has a single serialized task chain; per-peer depth is not tracked.',
    ].join('\n');
  },
};
