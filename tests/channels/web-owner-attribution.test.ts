/**
 * @file web-owner-attribution.test.ts
 * @description Web chat may ADMIT a loopback/LAN client without a token, but
 * it must never call that client the OWNER.
 *
 * Found by adversarial review (2026-08-16, CONCERN 1): every web turn was
 * dispatched with `isOwner: true` while the adapter skips auth for
 * 127.0.0.1, ::1, and private LAN ranges. Behind a reverse proxy every remote client
 * appears as 127.0.0.1 — so any caller was "the owner". Harmless while
 * everything was sandboxed; under god mode an owner-attributed web turn
 * executes on the REAL HOST.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebAdapter } from '../../src/core/channels/web.js';
import type { UnifiedMessage } from '../../src/core/channels/types.js';

const TOKEN = 'owner-token-under-test';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env['WEB_CHAT_TOKEN'];
  process.env['WEB_CHAT_TOKEN'] = TOKEN;
});

afterEach(() => {
  if (saved === undefined) delete process.env['WEB_CHAT_TOKEN'];
  else process.env['WEB_CHAT_TOKEN'] = saved;
});

/** Drive the adapter's private dispatch with a chosen proven-ness. */
async function dispatchWith(ownerProven: boolean): Promise<UnifiedMessage> {
  const adapter = new WebAdapter();
  const seen: UnifiedMessage[] = [];
  adapter.onMessage(async (m) => { seen.push(m); });
  (adapter as unknown as { _lastRequestOwnerProven: boolean })._lastRequestOwnerProven = ownerProven;
  await (adapter as unknown as {
    _dispatch(peerId: string, text: string): Promise<void>;
  })._dispatch('peer-1', 'hello');
  const msg = seen[0];
  if (!msg) throw new Error('adapter dispatched no message');
  return msg;
}

describe('web chat owner attribution', () => {
  it('is NOT owner when the token was never proven (loopback/LAN admission)', async () => {
    const msg = await dispatchWith(false);
    expect(msg.isOwner).toBe(false);
  });

  it('IS owner when the request proved WEB_CHAT_TOKEN', async () => {
    const msg = await dispatchWith(true);
    expect(msg.isOwner).toBe(true);
  });

  it('never reports owner as undefined (god mode requires an explicit answer)', async () => {
    // `ownerVerified === true` is the god-mode condition; an undefined here
    // would read as "not owner" today but is too easy to misread later.
    const msg = await dispatchWith(false);
    expect(typeof msg.isOwner).toBe('boolean');
  });
});
