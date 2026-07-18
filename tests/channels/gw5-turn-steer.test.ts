/**
 * @file tests/channels/gw5-turn-steer.test.ts
 * @description GW-5 flagship integration — createGatewayTurnHandler steers a
 * mid-run message into the ACTIVE run's steer buffer instead of queueing a whole
 * new turn behind it, honoring the media exclusion, the trust-tier guard, and the
 * SUDO_MIDRUN_STEER master flag. Uses a hung agentLoop.run to keep a run "active".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGatewayTurnHandler, type GatewayTurnDeps } from '../../src/core/channels/gateway-turn-handler.js';
import type { UnifiedMessage } from '../../src/core/channels/types.js';
import { KeyedAsyncQueue } from '../../src/core/sessions/queue.js';
import { __resetRunRegistryForTest, getRunRegistry } from '../../src/core/agent/run-registry.js';
import { __resetSteerBufferForTest, getSteerBuffer } from '../../src/core/agent/steer-buffer.js';
import { __resetQueueModeStoreForTest } from '../../src/core/channels/queue-modes.js';

interface Deferred { promise: Promise<{ text?: string }>; resolve: (v: { text?: string }) => void; }
function deferred(): Deferred {
  let resolve!: (v: { text?: string }) => void;
  const promise = new Promise<{ text?: string }>((r) => { resolve = r; });
  return { promise, resolve };
}
const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

function msg(text: string, opts: { isOwner?: boolean; media?: boolean } = {}): UnifiedMessage {
  return {
    id: Math.random().toString(36).slice(2),
    channel: 'telegram',
    peerId: 'u1',
    text,
    isOwner: opts.isOwner ?? true,
    media: opts.media ? [{ type: 'image/png', url: 'x', mimeType: 'image/png' } as never] : undefined,
  } as UnifiedMessage;
}

function makeDeps(runImpl: () => Promise<{ text?: string }>): { deps: GatewayTurnDeps; runSpy: ReturnType<typeof vi.fn> } {
  const runSpy = vi.fn(runImpl);
  const deps: GatewayTurnDeps = {
    sessionManager: {
      getOrCreate: async () => ({ id: 'sess1' }),
      appendEvent: async () => {},
      peerQueue: new KeyedAsyncQueue(),
    },
    agentLoop: { run: runSpy as never },
    runGenerations: { current: () => 0, isStale: () => false },
    send: async () => {},
    journal: false,
  };
  return { deps, runSpy };
}

beforeEach(() => {
  __resetRunRegistryForTest();
  __resetSteerBufferForTest();
  __resetQueueModeStoreForTest();
  process.env['SUDO_MIDRUN_STEER'] = '1';
  process.env['SUDO_QUEUE_MODE_DEFAULT'] = 'steer';
});
afterEach(() => {
  delete process.env['SUDO_MIDRUN_STEER'];
  delete process.env['SUDO_QUEUE_MODE_DEFAULT'];
  vi.restoreAllMocks();
});

describe('GW-5 turn handler mid-run steering', () => {
  it('a mid-run message is STEERED into the active run (not run as a new turn)', async () => {
    const d = deferred();
    const { deps, runSpy } = makeDeps(() => d.promise);
    const handler = createGatewayTurnHandler(deps);

    void handler(msg('start a long task')); // hangs inside agentLoop.run
    await tick();
    expect(getRunRegistry().isActive('telegram:u1')).toBe(true);

    await handler(msg('actually also do X')); // arrives mid-run
    // steered into the buffer keyed by the run's sessionId, NOT a second run
    expect(getSteerBuffer().size('sess1')).toBe(1);
    expect(runSpy).toHaveBeenCalledTimes(1);

    d.resolve({ text: 'done' });
    await tick();
  });

  it('MEDIA mid-run message is NOT steered → followup (queued as a new turn)', async () => {
    const d = deferred();
    const { deps, runSpy } = makeDeps(() => d.promise);
    const handler = createGatewayTurnHandler(deps);
    void handler(msg('long task'));
    await tick();
    void handler(msg('caption', { media: true })); // media → followup
    await tick();
    expect(getSteerBuffer().size('sess1')).toBe(0); // never buffered
    d.resolve({ text: 'done' });
    await tick();
  });

  it('TIER GUARD: untrusted mid-run message into an OWNER run is NOT steered', async () => {
    const d = deferred();
    const { deps } = makeDeps(() => d.promise);
    const handler = createGatewayTurnHandler(deps);
    void handler(msg('owner task', { isOwner: true })); // owner run
    await tick();
    void handler(msg('untrusted steer', { isOwner: false })); // would downgrade → followup (queues behind the hung run)
    await tick();
    expect(getSteerBuffer().size('sess1')).toBe(0);
    d.resolve({ text: 'done' });
    await tick();
  });

  it('flag OFF (SUDO_MIDRUN_STEER unset) → mid-run message is never steered', async () => {
    delete process.env['SUDO_MIDRUN_STEER'];
    const d = deferred();
    const { deps } = makeDeps(() => d.promise);
    const handler = createGatewayTurnHandler(deps);
    void handler(msg('task'));
    await tick();
    void handler(msg('more')); // no steering → normal enqueue behavior
    await tick();
    expect(getSteerBuffer().size('sess1')).toBe(0);
    d.resolve({ text: 'done' });
    await tick();
  });
});
