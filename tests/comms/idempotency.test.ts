/**
 * @file tests/comms/idempotency.test.ts
 * @description Tool-level comms idempotency: a re-dispatched send must not
 * double-fire. Verifies the claim ledger's begin/confirm/release lifecycle,
 * the dedup window, content vs explicit keys, and the opt-in flag.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CommsIdempotencyStore,
  deriveCommsKey,
  isCommsIdempotencyEnabled,
  type SendIdentity,
} from '../../src/core/comms/idempotency.js';

const T0 = Date.parse('2026-06-19T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const email = (over: Partial<SendIdentity> = {}): SendIdentity =>
  ({ channel: 'email', recipient: 'a@b.com', body: 'hello world', ...over });

describe('CommsIdempotencyStore', () => {
  let store: CommsIdempotencyStore;
  beforeEach(() => { store = new CommsIdempotencyStore(':memory:'); });
  afterEach(() => store.close());

  it('IDEM-1: first claim is fresh; a second identical claim in-flight is a duplicate', () => {
    const a = store.begin(email(), T0);
    expect(a.duplicate).toBe(false);
    const b = store.begin(email(), T0);
    expect(b.duplicate).toBe(true);        // pending in-flight → suppressed
    expect(b.key).toBe(a.key);
  });

  it('IDEM-2: a confirmed send is a duplicate within the window, returning the prior id', () => {
    const a = store.begin(email(), T0);
    store.confirm(a.key, 'msg-123');
    const b = store.begin(email(), T0 + 60_000); // 1 min later, inside 1h window
    expect(b.duplicate).toBe(true);
    expect(b.messageId).toBe('msg-123');
  });

  it('IDEM-3: releasing a failed claim allows a genuine retry', () => {
    const a = store.begin(email(), T0);
    store.release(a.key);                   // send failed → release
    const b = store.begin(email(), T0);
    expect(b.duplicate).toBe(false);        // retry proceeds
  });

  it('IDEM-4: different recipient or body yields a different key (not a duplicate)', () => {
    store.begin(email(), T0);
    expect(store.begin(email({ recipient: 'c@d.com' }), T0).duplicate).toBe(false);
    expect(store.begin(email({ body: 'different' }), T0).duplicate).toBe(false);
  });

  it('IDEM-5: an explicit key gives exact-once independent of body', () => {
    const k1 = store.begin(email({ explicitKey: 'task-42' }), T0);
    expect(k1.duplicate).toBe(false);
    // Same explicit key, totally different content → still a duplicate.
    const k2 = store.begin(email({ explicitKey: 'task-42', body: 'unrelated', recipient: 'x@y.com' }), T0);
    expect(k2.duplicate).toBe(true);
  });

  it('IDEM-6: a send older than the window is no longer a duplicate (stale reclaim)', () => {
    const a = store.begin(email(), T0);
    store.confirm(a.key, 'msg-1');
    const stale = store.begin(email(), T0 + HOUR + 1); // just past the 1h window
    expect(stale.duplicate).toBe(false);
  });
});

describe('deriveCommsKey & flag', () => {
  it('KEY-1: identical identity → identical key; explicit key overrides content', () => {
    expect(deriveCommsKey(email())).toBe(deriveCommsKey(email()));
    expect(deriveCommsKey(email({ explicitKey: 'k' }))).toBe('k');
    expect(deriveCommsKey(email())).not.toBe(deriveCommsKey(email({ body: 'x' })));
  });

  it('FLAG-1: idempotency is off by default and requires exact "1"', () => {
    const saved = process.env['SUDO_COMMS_IDEMPOTENCY'];
    delete process.env['SUDO_COMMS_IDEMPOTENCY'];
    expect(isCommsIdempotencyEnabled()).toBe(false);
    process.env['SUDO_COMMS_IDEMPOTENCY'] = 'true';
    expect(isCommsIdempotencyEnabled()).toBe(false);
    process.env['SUDO_COMMS_IDEMPOTENCY'] = '1';
    expect(isCommsIdempotencyEnabled()).toBe(true);
    if (saved === undefined) delete process.env['SUDO_COMMS_IDEMPOTENCY'];
    else process.env['SUDO_COMMS_IDEMPOTENCY'] = saved;
  });
});
