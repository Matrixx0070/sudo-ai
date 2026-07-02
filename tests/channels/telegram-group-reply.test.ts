/**
 * Regression for P0 #3: Telegram group replies must target the group chat,
 * not the sender's DM.
 *
 * The adapter normalizes an inbound message into a UnifiedMessage. peerId is
 * the SENDER's user id (session/identity key); chatId is the DELIVERY target —
 * the group id in a group, the user id in a DM. cli.ts replies to
 * `msg.chatId ?? msg.peerId`, so getting chatId right is what routes group
 * replies back to the group instead of the sender's DM (which 403s unless the
 * user has /start'ed the bot).
 */

import { describe, it, expect } from 'vitest';
import { TelegramAdapter } from '../../src/core/channels/telegram.js';
import type { UnifiedMessage } from '../../src/core/channels/types.js';

interface Inbound {
  _handleInbound(ctx: unknown, text: string, media: unknown[]): Promise<void>;
  _replyTargetOf(ctx: unknown): string;
}

function mockCtx(opts: { userId: number; chatId: number; chatType: 'private' | 'group' | 'supergroup' }) {
  return {
    from: { id: opts.userId, first_name: 'Alice' },
    chat: { id: opts.chatId, type: opts.chatType },
    message: { message_id: 42, date: Math.floor(1_700_000_000) },
    // sendChatAction etc. are reached via adapter.bot, which is undefined here.
  };
}

async function capture(
  ctx: ReturnType<typeof mockCtx>,
  userId: string,
): Promise<UnifiedMessage> {
  const adapter = new TelegramAdapter('TELEGRAM_BOT_TOKEN', [userId]);
  let captured: UnifiedMessage | undefined;
  adapter.onMessage(async (m) => { captured = m; });
  await (adapter as unknown as Inbound)._handleInbound(ctx, 'hello', []);
  if (!captured) throw new Error('handler was not invoked');
  return captured;
}

describe('Telegram inbound routing (P0 #3)', () => {
  it('group message: chatId is the group id and differs from peerId (the sender)', async () => {
    const msg = await capture(
      mockCtx({ userId: 111, chatId: -1002220, chatType: 'supergroup' }),
      '111',
    );
    expect(msg.peerId).toBe('111');       // sender / session key
    expect(msg.chatId).toBe('-1002220');  // reply target = the group
    expect(msg.chatId).not.toBe(msg.peerId);
    expect(msg.chatType).toBe('group');
  });

  it('DM: chatId equals peerId (both the user id)', async () => {
    const msg = await capture(
      mockCtx({ userId: 222, chatId: 222, chatType: 'private' }),
      '222',
    );
    expect(msg.peerId).toBe('222');
    expect(msg.chatId).toBe('222');
    expect(msg.chatType).toBe('dm');
  });

  // _replyTargetOf is the single derivation shared by _handleInbound and the
  // voice/audio handlers' voice-reply marker, so they can't drift apart (the
  // audio handler previously keyed by the sender, misrouting in groups).
  it('_replyTargetOf prefers the chat id, falls back to the sender', () => {
    const a = new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']) as unknown as Inbound;
    expect(a._replyTargetOf({ from: { id: 111 }, chat: { id: -1002220 } })).toBe('-1002220'); // group
    expect(a._replyTargetOf({ from: { id: 222 }, chat: { id: 222 } })).toBe('222');            // dm
    expect(a._replyTargetOf({ from: { id: 333 } })).toBe('333');                               // no chat → sender
    expect(a._replyTargetOf({})).toBe('unknown');
  });
});
