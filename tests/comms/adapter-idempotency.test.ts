/**
 * @file tests/comms/adapter-idempotency.test.ts
 * @description Adapter-layer live-reply guard (opt-in, SUDO_COMMS_ADAPTER_IDEMPOTENCY=1).
 * maybeGuardedSend wraps a raw adapter send call site so an identical live reply
 * isn't sent twice; default-off preserves current behaviour. Retries inside the
 * adapter run within sendFn (below this guard) so they are never re-suppressed.
 * Workspace redirected via SUDO_AI_HOME so the singleton store hits a temp DB.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync } from 'node:fs';

const { ROOT, priorHome, priorData } = vi.hoisted(() => {
  const base = (process.env['TMPDIR'] || '/tmp').replace(/\/+$/, '');
  const root = `${base}/sudo-adapter-idem-test`;
  const priorHome = process.env['SUDO_AI_HOME'];
  const priorData = process.env['DATA_DIR'];
  process.env['SUDO_AI_HOME'] = root;
  delete process.env['DATA_DIR'];
  return { ROOT: root, priorHome, priorData };
});

import { maybeGuardedSend, isCommsAdapterIdempotencyEnabled } from '../../src/core/comms/idempotency.js';

let n = 0;
beforeEach(() => { delete process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY']; n += 1; });
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env['SUDO_AI_HOME']; else process.env['SUDO_AI_HOME'] = priorHome;
  if (priorData === undefined) delete process.env['DATA_DIR']; else process.env['DATA_DIR'] = priorData;
  delete process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'];
});

describe('maybeGuardedSend — adapter-layer live-reply guard', () => {
  it('ADP-1: flag OFF (default) — always sends, never dedups', async () => {
    let calls = 0;
    const r1 = await maybeGuardedSend('telegram', `peer${n}`, 'hi', async () => { calls += 1; });
    const r2 = await maybeGuardedSend('telegram', `peer${n}`, 'hi', async () => { calls += 1; });
    expect([r1, r2]).toEqual([true, true]);
    expect(calls).toBe(2);
  });

  it('ADP-2: flag ON — first sends; an identical second is suppressed', async () => {
    process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'] = '1';
    let calls = 0;
    const body = `reply-${n}`;
    const r1 = await maybeGuardedSend('telegram', `peerA${n}`, body, async () => { calls += 1; });
    const r2 = await maybeGuardedSend('telegram', `peerA${n}`, body, async () => { calls += 1; });
    expect(r1).toBe(true);
    expect(r2).toBe(false); // duplicate suppressed
    expect(calls).toBe(1);
  });

  it('ADP-3: flag ON — a failed send releases the claim so a retry proceeds', async () => {
    process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'] = '1';
    let calls = 0;
    const body = `reply-fail-${n}`;
    await expect(
      maybeGuardedSend('telegram', `peerB${n}`, body, async () => { calls += 1; throw new Error('net'); }),
    ).rejects.toThrow('net');
    const r2 = await maybeGuardedSend('telegram', `peerB${n}`, body, async () => { calls += 1; });
    expect(r2).toBe(true);
    expect(calls).toBe(2); // released → retried
  });

  it('ADP-4: flag gate requires exact "1"', () => {
    delete process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'];
    expect(isCommsAdapterIdempotencyEnabled()).toBe(false);
    process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'] = 'true';
    expect(isCommsAdapterIdempotencyEnabled()).toBe(false);
    process.env['SUDO_COMMS_ADAPTER_IDEMPOTENCY'] = '1';
    expect(isCommsAdapterIdempotencyEnabled()).toBe(true);
  });
});
