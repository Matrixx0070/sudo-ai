/**
 * @file tests/channels/gw5-steer-runend-clear.test.ts
 * @description GW-5 MEDIUM-1: a steer that lands after the loop's final drain but
 * before run-end must NOT leak into the next run for the same session. The turn
 * handler's finally clears the session's steer buffer, so a subsequent unrelated
 * run starts with an empty buffer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGatewayTurnHandler, type GatewayTurnDeps } from '../../src/core/channels/gateway-turn-handler.js';
import type { UnifiedMessage } from '../../src/core/channels/types.js';
import { KeyedAsyncQueue } from '../../src/core/sessions/queue.js';
import { __resetRunRegistryForTest } from '../../src/core/agent/run-registry.js';
import { __resetSteerBufferForTest, getSteerBuffer } from '../../src/core/agent/steer-buffer.js';
import { __resetQueueModeStoreForTest } from '../../src/core/channels/queue-modes.js';

interface Deferred { promise: Promise<{ text?: string }>; resolve: (v: { text?: string }) => void; }
function deferred(): Deferred {
  let resolve!: (v: { text?: string }) => void;
  const promise = new Promise<{ text?: string }>((r) => { resolve = r; });
  return { promise, resolve };
}
const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

function msg(text: string): UnifiedMessage {
  return { id: Math.random().toString(36).slice(2), channel: 'telegram', peerId: 'u1', text, isOwner: true } as UnifiedMessage;
}

const SESSION_ID = 'sess1';

function makeDeps(runImpl: () => Promise<{ text?: string }>): GatewayTurnDeps {
  return {
    sessionManager: {
      getOrCreate: async () => ({ id: SESSION_ID }),
      appendEvent: async () => {},
      peerQueue: new KeyedAsyncQueue(),
    },
    agentLoop: { run: vi.fn(runImpl) as never },
    runGenerations: { current: () => 0, isStale: () => false },
    send: async () => {},
    journal: false,
  };
}

beforeEach(() => {
  __resetRunRegistryForTest();
  __resetSteerBufferForTest();
  __resetQueueModeStoreForTest();
  process.env['SUDO_MIDRUN_STEER'] = '1';
});
afterEach(() => {
  delete process.env['SUDO_MIDRUN_STEER'];
  vi.restoreAllMocks();
});

describe('GW-5 run-end steer clear (MEDIUM-1)', () => {
  it('a steer buffered during a run that ends is NOT carried into the next run', async () => {
    const d = deferred();
    const handler = createGatewayTurnHandler(makeDeps(() => d.promise));

    // Run A starts and hangs.
    const runA = handler(msg('long task'));
    await tick();

    // A steer lands mid-run — simulate the race where it slips in after the loop's
    // final drain but before run-end by pushing directly into the buffer for the
    // active session.
    getSteerBuffer().push(SESSION_ID, 'orphaned steer', 'owner');
    expect(getSteerBuffer().size(SESSION_ID)).toBe(1);

    // Run A completes → finally clears the buffer.
    d.resolve({ text: 'A done' });
    await runA;

    // The orphaned steer was discarded, not carried forward.
    expect(getSteerBuffer().size(SESSION_ID)).toBe(0);
    // A subsequent unrelated run therefore drains nothing.
    expect(getSteerBuffer().drain(SESSION_ID)).toEqual([]);
  });
});
