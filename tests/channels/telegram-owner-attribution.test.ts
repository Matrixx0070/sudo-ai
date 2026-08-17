/**
 * @file telegram-owner-attribution.test.ts
 * @description Telegram messages must carry owner attribution.
 *
 * Found live (2026-08-17): god mode was enabled and proven in unit tests, yet
 * the owner's real Telegram command still ran sandboxed. Cause: the Telegram
 * adapter never set `UnifiedMessage.isOwner`, and the shared channel turn in
 * cli.ts never passed a `caller`, so `ctx.isOwner` was undefined for every
 * Telegram turn — god mode applied to nobody on the one channel the owner
 * actually uses.
 *
 * Owner status comes from the constructor allowlist (TELEGRAM_CHAT_ID).
 * Pairing-admitted users are admitted but are NOT owners.
 */

import { describe, it, expect } from 'vitest';
import { TelegramAdapter } from '../../src/core/channels/telegram.js';

const OWNER = '8087386717';
const STRANGER = '999000111';

function makeAdapter(allowed: string[]): TelegramAdapter {
  // (tokenEnvKey, allowedUsers) — allowedUsers seeds BOTH the admission set
  // and the owner set; pairing adds to admission only.
  return new TelegramAdapter('TELEGRAM_BOT_TOKEN', allowed);
}

describe('telegram owner attribution', () => {
  it('treats a constructor-allowlisted user as the owner', () => {
    const a = makeAdapter([OWNER]);
    expect(a.isOwnerUser(OWNER)).toBe(true);
  });

  it('does NOT treat an unknown sender as the owner', () => {
    const a = makeAdapter([OWNER]);
    expect(a.isOwnerUser(STRANGER)).toBe(false);
  });

  it('does NOT treat a pairing-admitted user as the owner', () => {
    // Pairing admits a peer for conversation; it must never confer the owner
    // authority god mode keys off.
    const a = makeAdapter([OWNER]);
    const admitted = a as unknown as { allowedUsers: Set<string> };
    admitted.allowedUsers.add(STRANGER);
    expect(a.isOwnerUser(STRANGER)).toBe(false);
  });

  it('exposes owner status as the same set the message stamp uses', () => {
    // The inbound message stamps `isOwner: this.ownerUsers.has(userId)`, which
    // is exactly what isOwnerUser() reports — pinned so the two cannot drift.
    const a = makeAdapter([OWNER]);
    const internals = a as unknown as { ownerUsers: Set<string> };
    expect(internals.ownerUsers.has(OWNER)).toBe(a.isOwnerUser(OWNER));
    expect(internals.ownerUsers.has(STRANGER)).toBe(a.isOwnerUser(STRANGER));
  });
});
