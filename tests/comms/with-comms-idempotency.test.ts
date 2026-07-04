/**
 * withCommsIdempotency — reusable tool-level guard that makes builtin comms tools
 * (slack, gmail, webhook, gcalendar, …) replay-safe: a re-run turn that repeats
 * an identical send within the window is suppressed instead of double-delivering.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  withCommsIdempotency,
  CommsIdempotencyStore,
  __setCommsIdempotencyStoreForTests,
} from '../../src/core/comms/idempotency.js';

const ID = { channel: 'slack', recipient: '#general', body: 'deploy is green' };

describe('withCommsIdempotency', () => {
  let savedFlag: string | undefined;
  beforeEach(() => {
    savedFlag = process.env['SUDO_COMMS_IDEMPOTENCY'];
    __setCommsIdempotencyStoreForTests(new CommsIdempotencyStore(':memory:'));
  });
  afterEach(() => {
    __setCommsIdempotencyStoreForTests(null);
    if (savedFlag === undefined) delete process.env['SUDO_COMMS_IDEMPOTENCY'];
    else process.env['SUDO_COMMS_IDEMPOTENCY'] = savedFlag;
  });

  it('runs the send unguarded when the flag is off', async () => {
    delete process.env['SUDO_COMMS_IDEMPOTENCY'];
    const send = vi.fn().mockResolvedValue({ ts: '1' });
    const a = await withCommsIdempotency(ID, send);
    const b = await withCommsIdempotency(ID, send);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false); // no dedup when disabled
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('suppresses an identical repeat within the window when the flag is on', async () => {
    process.env['SUDO_COMMS_IDEMPOTENCY'] = '1';
    const send = vi.fn().mockResolvedValue({ ts: '99' });
    const first = await withCommsIdempotency(ID, send, (r) => r.ts);
    const second = await withCommsIdempotency(ID, send, (r) => r.ts);
    expect(first.duplicate).toBe(false);
    expect(first.result).toEqual({ ts: '99' });
    expect(second.duplicate).toBe(true);
    expect(second.messageId).toBe('99'); // prior id surfaced
    expect(send).toHaveBeenCalledTimes(1); // the real send ran exactly once
  });

  it('does not suppress a genuinely different send', async () => {
    process.env['SUDO_COMMS_IDEMPOTENCY'] = '1';
    const send = vi.fn().mockResolvedValue({ ts: 'x' });
    await withCommsIdempotency(ID, send);
    const other = await withCommsIdempotency({ ...ID, body: 'a different message' }, send);
    expect(other.duplicate).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('releases the claim when the send throws, so a real retry can proceed', async () => {
    process.env['SUDO_COMMS_IDEMPOTENCY'] = '1';
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient network error'))
      .mockResolvedValueOnce({ ts: 'ok' });
    await expect(withCommsIdempotency(ID, send)).rejects.toThrow('transient network error');
    // The failed send released its claim → the retry is NOT seen as a duplicate.
    const retry = await withCommsIdempotency(ID, send, (r) => r.ts);
    expect(retry.duplicate).toBe(false);
    expect(retry.result).toEqual({ ts: 'ok' });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
