/**
 * @file tests/channels/owner-interrupt.test.ts
 * @description Owner-interrupt: the owner's newest message preempts a running
 * loop immediately (abort + run the new message), instead of steering it into
 * the old loop or queueing behind it. Untrusted messages never interrupt.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGatewayTurnHandler, type GatewayTurnDeps } from '../../src/core/channels/gateway-turn-handler.js';
import type { UnifiedMessage } from '../../src/core/channels/types.js';
import { KeyedAsyncQueue } from '../../src/core/sessions/queue.js';
import { __resetRunRegistryForTest } from '../../src/core/agent/run-registry.js';
import { __resetSteerBufferForTest, getSteerBuffer } from '../../src/core/agent/steer-buffer.js';
import { __resetQueueModeStoreForTest } from '../../src/core/channels/queue-modes.js';

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
function ownerMsg(text: string): UnifiedMessage {
  return { id: Math.random().toString(36).slice(2), channel: 'signal', peerId: 'owner1', text, isOwner: true } as UnifiedMessage;
}
function strangerMsg(text: string): UnifiedMessage {
  return { id: Math.random().toString(36).slice(2), channel: 'signal', peerId: 'owner1', text, isOwner: false } as UnifiedMessage;
}
const SESSION_ID = 'sess1';

interface Harness { handler: (m: UnifiedMessage) => Promise<void>; runTexts: string[]; sent: string[]; aborts: Array<{ sid: string; reason: string }>; releaseFirst: () => void; }

function harness(): Harness {
  const runTexts: string[] = [];
  const sent: string[] = [];
  const aborts: Array<{ sid: string; reason: string }> = [];
  let firstResolve: (() => void) | null = null;
  const releaseFirst = () => firstResolve?.();
  let call = 0;
  const deps: GatewayTurnDeps = {
    sessionManager: { getOrCreate: async () => ({ id: SESSION_ID }), appendEvent: async () => {}, peerQueue: new KeyedAsyncQueue() },
    agentLoop: {
      run: vi.fn((_sid: string, text: string) => {
        runTexts.push(text);
        call++;
        if (call === 1) return new Promise<{ text?: string }>((res) => { firstResolve = () => res({ text: `A-done` }); });
        return Promise.resolve({ text: `answer:${text}` });
      }) as never,
    },
    runGenerations: { current: () => 0, isStale: () => false },
    send: async (_m, text) => { sent.push(text); },
    journal: false,
    serialize: false,
    // The abort seam the loop honours — here it also releases the hung first run
    // to model the loop stopping at its next boundary.
    abortRun: (sid, reason) => { aborts.push({ sid, reason }); releaseFirst(); },
  };
  return { handler: createGatewayTurnHandler(deps), runTexts, sent, aborts, releaseFirst };
}

beforeEach(() => {
  __resetRunRegistryForTest();
  __resetSteerBufferForTest();
  __resetQueueModeStoreForTest();
  process.env['SUDO_MIDRUN_STEER'] = '1';
  process.env['SUDO_QUEUE_MODE_DEFAULT'] = 'steer';
  delete process.env['SUDO_OWNER_INTERRUPTS'];
});
afterEach(() => {
  delete process.env['SUDO_MIDRUN_STEER'];
  delete process.env['SUDO_QUEUE_MODE_DEFAULT'];
  delete process.env['SUDO_OWNER_INTERRUPTS'];
  vi.restoreAllMocks();
});

describe('owner-interrupt', () => {
  it('an owner message aborts the active run and runs the new message', async () => {
    const h = harness();
    const p1 = h.handler(ownerMsg('long autonomous loop'));
    await tick();
    // Second owner message arrives mid-run.
    const p2 = h.handler(ownerMsg('stop and take a screenshot'));
    await Promise.all([p1, p2]);
    await tick(30);

    // The run was interrupted (abort signalled for the active session)…
    expect(h.aborts.length).toBe(1);
    expect(h.aborts[0]).toMatchObject({ sid: SESSION_ID });
    // …and the new owner message ran and was answered (not steered/buffered).
    expect(h.runTexts).toContain('stop and take a screenshot');
    expect(h.sent).toContain('answer:stop and take a screenshot');
    // It did NOT go into the steer buffer.
    expect(getSteerBuffer().size(SESSION_ID)).toBe(0);
  });

  it('an UNTRUSTED message does NOT interrupt an owner run (steer tier guard → followup)', async () => {
    const h = harness();
    const p1 = h.handler(ownerMsg('owner long task'));
    await tick();
    const p2 = h.handler(strangerMsg('please stop everything'));
    // The stranger message must not abort the owner's run.
    await tick();
    expect(h.aborts.length).toBe(0);
    // Release the first run so the test completes cleanly.
    h.releaseFirst();
    await Promise.all([p1, p2]);
  });

  it('with SUDO_OWNER_INTERRUPTS=0 the owner message steers instead of interrupting', async () => {
    process.env['SUDO_OWNER_INTERRUPTS'] = '0';
    const h = harness();
    const p1 = h.handler(ownerMsg('owner long task'));
    await tick();
    const p2 = h.handler(ownerMsg('extra context'));
    await tick();
    // No abort; the message was steered into the buffer for the running loop.
    expect(h.aborts.length).toBe(0);
    expect(getSteerBuffer().size(SESSION_ID)).toBe(1);
    h.releaseFirst();
    await Promise.all([p1, p2]);
  });
});
