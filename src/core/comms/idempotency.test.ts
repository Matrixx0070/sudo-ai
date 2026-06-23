/**
 * @file idempotency.test.ts
 * @description Tests for the comms idempotency guard.
 *
 * Coverage:
 * - deriveCommsKey: explicit key passthrough, hash determinism, distinct inputs
 * - CommsIdempotencyStore.begin: fresh claim, duplicate suppression, confirm, release
 * - Stale pending expiry (crashed sender recovery) — the bug fix
 * - Stale sent expiry (reclaim after window)
 * - maybeGuardedSend: flag-off passthrough, flag-on dedup, fail-open, release-on-error
 * - isCommsIdempotencyEnabled / isCommsAdapterIdempotencyEnabled env gating
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveCommsKey,
  CommsIdempotencyStore,
  isCommsIdempotencyEnabled,
  isCommsAdapterIdempotencyEnabled,
  maybeGuardedSend,
  type SendIdentity,
} from './idempotency.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dbPath: string;
let store: CommsIdempotencyStore;

function mkStore(): CommsIdempotencyStore {
  return new CommsIdempotencyStore(dbPath);
}

const ID: SendIdentity = {
  channel: 'telegram',
  recipient: '12345',
  body: 'hello world',
};

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('deriveCommsKey', () => {
  it('uses explicitKey verbatim when provided', () => {
    const key = deriveCommsKey({ ...ID, explicitKey: 'task-42' });
    expect(key).toBe('task-42');
  });

  it('uses explicitKey verbatim after trimming whitespace', () => {
    const key = deriveCommsKey({ ...ID, explicitKey: '  task-42  ' });
    expect(key).toBe('task-42');
  });

  it('falls back to hash when explicitKey is empty', () => {
    const key = deriveCommsKey({ ...ID, explicitKey: '' });
    expect(key).toHaveLength(64); // sha256 hex
    expect(key).not.toBe('');
  });

  it('falls back to hash when explicitKey is whitespace-only', () => {
    const key = deriveCommsKey({ ...ID, explicitKey: '   ' });
    expect(key).toHaveLength(64);
  });

  it('produces the same hash for identical inputs', () => {
    const k1 = deriveCommsKey(ID);
    const k2 = deriveCommsKey({ ...ID });
    expect(k1).toBe(k2);
  });

  it('produces different hashes for different bodies', () => {
    const k1 = deriveCommsKey(ID);
    const k2 = deriveCommsKey({ ...ID, body: 'hello earth' });
    expect(k1).not.toBe(k2);
  });

  it('produces different hashes for different channels', () => {
    const k1 = deriveCommsKey(ID);
    const k2 = deriveCommsKey({ ...ID, channel: 'email' });
    expect(k1).not.toBe(k2);
  });

  it('produces different hashes for different recipients', () => {
    const k1 = deriveCommsKey(ID);
    const k2 = deriveCommsKey({ ...ID, recipient: '67890' });
    expect(k1).not.toBe(k2);
  });
});

describe('CommsIdempotencyStore', () => {
  beforeEach(() => {
    dbPath = join(tmpdir(), `idem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = mkStore();
  });

  afterEach(() => {
    store.close();
  });

  describe('begin', () => {
    it('returns duplicate=false for a fresh claim', () => {
      const result = store.begin(ID);
      expect(result.duplicate).toBe(false);
      expect(result.key).toHaveLength(64);
      expect(result.messageId).toBeUndefined();
    });

    it('returns duplicate=true for a second begin within the window', () => {
      store.begin(ID);
      const result = store.begin(ID);
      expect(result.duplicate).toBe(true);
      expect(result.key).toHaveLength(64);
    });

    it('returns the confirmed messageId on a duplicate after confirm', () => {
      const claim = store.begin(ID);
      store.confirm(claim.key, 'msg-001');
      const result = store.begin(ID);
      expect(result.duplicate).toBe(true);
      expect(result.messageId).toBe('msg-001');
    });

    it('uses explicit key when provided', () => {
      const result = store.begin({ ...ID, explicitKey: 'task-99' });
      expect(result.duplicate).toBe(false);
      expect(result.key).toBe('task-99');
    });
  });

  describe('confirm', () => {
    it('marks a pending claim as sent with messageId', () => {
      const claim = store.begin(ID);
      store.confirm(claim.key, 'msg-100');
      const result = store.begin(ID);
      expect(result.duplicate).toBe(true);
      expect(result.messageId).toBe('msg-100');
    });

    it('marks a pending claim as sent with null messageId', () => {
      const claim = store.begin(ID);
      store.confirm(claim.key);
      const result = store.begin(ID);
      expect(result.duplicate).toBe(true);
      expect(result.messageId).toBeUndefined();
    });
  });

  describe('release', () => {
    it('deletes the claim so a retry can proceed', () => {
      const claim = store.begin(ID);
      store.release(claim.key);
      const result = store.begin(ID);
      expect(result.duplicate).toBe(false);
    });
  });

  describe('stale pending expiry (crashed sender recovery)', () => {
    it('reclaims a pending claim older than the window', () => {
      const WINDOW = 60 * 60 * 1000; // 1h default
      const now = Date.now();

      // Simulate a crashed sender: begin() at now-2h, never confirmed/released.
      const staleTime = now - 2 * WINDOW;
      const claim = store.begin(ID, staleTime);
      expect(claim.duplicate).toBe(false);

      // A new begin() at current time should reclaim, not suppress.
      const result = store.begin(ID, now);
      expect(result.duplicate).toBe(false);
      expect(result.key).toBe(claim.key);
    });

    it('suppresses a pending claim within the window', () => {
      const WINDOW = 60 * 60 * 1000;
      const now = Date.now();

      // begin() 30 minutes ago — still inside the 1h window.
      const claim = store.begin(ID, now - WINDOW / 2);
      expect(claim.duplicate).toBe(false);

      // A new begin() should be suppressed.
      const result = store.begin(ID, now);
      expect(result.duplicate).toBe(true);
    });
  });

  describe('stale sent expiry (reclaim after window)', () => {
    it('reclaims a confirmed send older than the window', () => {
      const WINDOW = 60 * 60 * 1000;
      const now = Date.now();

      // Sent 2h ago — outside the window.
      const claim = store.begin(ID, now - 2 * WINDOW);
      store.confirm(claim.key, 'old-msg');

      // New begin() should reclaim.
      const result = store.begin(ID, now);
      expect(result.duplicate).toBe(false);
    });

    it('suppresses a confirmed send within the window', () => {
      const WINDOW = 60 * 60 * 1000;
      const now = Date.now();

      const claim = store.begin(ID, now - WINDOW / 2);
      store.confirm(claim.key, 'recent-msg');

      const result = store.begin(ID, now);
      expect(result.duplicate).toBe(true);
      expect(result.messageId).toBe('recent-msg');
    });
  });

  describe('close', () => {
    it('can be called without error', () => {
      expect(() => store.close()).not.toThrow();
    });

    it('is idempotent (double close does not throw)', () => {
      store.close();
      expect(() => store.close()).not.toThrow();
    });
  });
});

describe('env-gated flags', () => {
  const origIdem = process.env['SUDO_COMMS_IDEMPOTENCY'];
  const origAdapter = process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'];

  afterEach(() => {
    delete process.env['SUDO_COMMS_IDEMPOTENCY'];
    delete process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'];
    if (origIdem !== undefined) process.env['SUDO_COMMS_IDEMPOTENCY'] = origIdem;
    if (origAdapter !== undefined) process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'] = origAdapter;
  });

  it('isCommsIdempotencyEnabled returns false by default', () => {
    delete process.env['SUDO_COMMS_IDEMPOTENCY'];
    expect(isCommsIdempotencyEnabled()).toBe(false);
  });

  it('isCommsIdempotencyEnabled returns true when SUDO_COMMS_IDEMPOTENCY=1', () => {
    process.env['SUDO_COMMS_IDEMPOTENCY'] = '1';
    expect(isCommsIdempotencyEnabled()).toBe(true);
  });

  it('isCommsAdapterIdempotencyEnabled returns false by default', () => {
    delete process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'];
    expect(isCommsAdapterIdempotencyEnabled()).toBe(false);
  });

  it('isCommsAdapterIdempotencyEnabled returns true when SUDO_COMMS_ADAPTER_IDEMPOTENCY=1', () => {
    process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'] = '1';
    expect(isCommsAdapterIdempotencyEnabled()).toBe(true);
  });
});

describe('maybeGuardedSend', () => {
  beforeEach(() => {
    dbPath = join(tmpdir(), `idem-send-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = mkStore();
  });

  afterEach(() => {
    store.close();
    delete process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'];
  });

  it('calls sendFn and returns true when adapter flag is off', async () => {
    delete process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'];
    let called = false;
    const result = await maybeGuardedSend('telegram', '123', 'hi', async () => {
      called = true;
    });
    expect(result).toBe(true);
    expect(called).toBe(true);
  });

  it('suppresses a duplicate send when adapter flag is on', async () => {
    process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'] = '1';
    let callCount = 0;
    const sendFn = async () => { callCount++; };

    // First send goes through.
    const r1 = await maybeGuardedSend('telegram', '123', 'hi', sendFn);
    expect(r1).toBe(true);
    expect(callCount).toBe(1);

    // Second identical send is suppressed.
    const r2 = await maybeGuardedSend('telegram', '123', 'hi', sendFn);
    expect(r2).toBe(false);
    expect(callCount).toBe(1); // sendFn not called again
  });

  it('allows a different body through when adapter flag is on', async () => {
    process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'] = '1';
    let callCount = 0;
    const sendFn = async () => { callCount++; };

    await maybeGuardedSend('telegram', '123', 'first', sendFn);
    await maybeGuardedSend('telegram', '123', 'second', sendFn);
    expect(callCount).toBe(2);
  });

  it('releases the claim on sendFn error so a retry can proceed', async () => {
    process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'] = '1';
    let callCount = 0;

    // First call throws.
    await expect(
      maybeGuardedSend('telegram', '123', 'fail-msg', async () => {
        callCount++;
        throw new Error('provider down');
      }),
    ).rejects.toThrow('provider down');
    expect(callCount).toBe(1);

    // Retry should go through (claim was released).
    const r2 = await maybeGuardedSend('telegram', '123', 'fail-msg', async () => {
      callCount++;
    });
    expect(r2).toBe(true);
    expect(callCount).toBe(2);
  });
});