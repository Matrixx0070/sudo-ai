/**
 * @file tests/channels/telegram-pairing.test.ts
 * @description GW-6 Telegram wiring. Proves the pairing path is adapter-level and
 * ZERO-LLM: an unknown sender on a pairing channel gets a code reply and NO agent
 * turn is scheduled (the message handler is never invoked); the owner /pair
 * approve command admits the peer (adapter-level); and non-pairing policy keeps
 * the silent-drop behavior. Pure-logic per the telegram test house pattern.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/core/channels/telegram.js';
import { __resetPairingSingletonForTest, getPairingManager } from '../../src/core/channels/pairing.js';

interface Internals {
  _handleInbound(ctx: unknown, text: string, media: unknown[]): Promise<void>;
  _isAllowed(userId: string): boolean;
}
const internals = (a: TelegramAdapter): Internals => a as unknown as Internals;

function stubCtx(userId: string): { ctx: unknown; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    from: { id: Number(userId) || userId },
    chat: { id: Number(userId) || userId },
    reply: async (t: string) => { replies.push(t); },
  };
  return { ctx, replies };
}

let saved: Record<string, string | undefined>;
let dir: string;
const ENV = ['DATA_DIR', 'TELEGRAM_DM_POLICY', 'TELEGRAM_BOT_TOKEN'] as const;

beforeEach(() => {
  saved = {};
  for (const k of ENV) saved[k] = process.env[k];
  dir = mkdtempSync(path.join(tmpdir(), 'tg-pairing-'));
  process.env['DATA_DIR'] = dir;
  process.env['TELEGRAM_BOT_TOKEN'] = 'x';
  __resetPairingSingletonForTest();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
  __resetPairingSingletonForTest();
  vi.restoreAllMocks();
});

describe('GW-6 Telegram pairing wiring', () => {
  it('unknown sender on pairing policy → code reply, NO agent turn scheduled', async () => {
    process.env['TELEGRAM_DM_POLICY'] = 'pairing';
    const a = new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']); // owner = "1"
    const handler = vi.fn(async () => {});
    a.onMessage(handler as never);

    const { ctx, replies } = stubCtx('999');
    await internals(a)._handleInbound(ctx, 'please let me in', []);

    // message NOT processed (no agent turn) — handler never called
    expect(handler).not.toHaveBeenCalled();
    // adapter-level code reply issued
    expect(replies).toHaveLength(1);
    const code = replies[0]!.match(/[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}/)?.[0];
    expect(code).toBeTruthy();
    // and a pending entry exists in the store
    expect(getPairingManager().listPending('telegram', 'TELEGRAM_BOT_TOKEN')).toHaveLength(1);
  });

  it('unknown sender on ALLOWLIST policy (default) → silent drop, no reply', async () => {
    // TELEGRAM_DM_POLICY unset ⇒ allowlist
    const a = new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']);
    const handler = vi.fn(async () => {});
    a.onMessage(handler as never);
    const { ctx, replies } = stubCtx('999');
    await internals(a)._handleInbound(ctx, 'hi', []);
    expect(handler).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });

  it('owner /pair approve <code> admits the peer at the adapter level', async () => {
    process.env['TELEGRAM_DM_POLICY'] = 'pairing';
    const a = new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']);
    a.onMessage((async () => {}) as never);

    // unknown sender requests
    const req = stubCtx('999');
    await internals(a)._handleInbound(req.ctx, 'hello', []);
    const code = req.replies[0]!.match(/[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}/)![0];
    expect(internals(a)._isAllowed('999')).toBe(false);

    // owner approves via /pair
    const owner = stubCtx('1');
    await internals(a)._handleInbound(owner.ctx, `/pair approve ${code}`, []);
    expect(owner.replies[0]).toMatch(/Approved/);
    expect(internals(a)._isAllowed('999')).toBe(true); // peer now admitted
  });

  it('/pair from a NON-owner is not treated as an admin command', async () => {
    process.env['TELEGRAM_DM_POLICY'] = 'pairing';
    const a = new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']);
    a.onMessage((async () => {}) as never);
    // sender 999 is unknown → hits the pairing path, not the /pair admin path
    const { ctx, replies } = stubCtx('999');
    await internals(a)._handleInbound(ctx, '/pair approve SOMECODE', []);
    // gets a pairing code (unknown sender), NOT an "Approved"/usage admin reply
    expect(replies[0]).not.toMatch(/Approved|Usage/);
    expect(replies[0]).toMatch(/pairing code/i);
  });
});
