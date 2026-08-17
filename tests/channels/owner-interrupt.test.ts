/**
 * @file tests/channels/owner-interrupt.test.ts
 * @description Owner mid-run handling. DEFAULT = concurrent: the owner's 2nd
 * message is answered in the BACKGROUND on a side session while the running task
 * keeps going (no interrupt). SUDO_OWNER_MIDRUN=interrupt restores abort+restart.
 * Untrusted messages never interrupt or spawn a concurrent run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGatewayTurnHandler, type GatewayTurnDeps } from '../../src/core/channels/gateway-turn-handler.js';
import type { UnifiedMessage } from '../../src/core/channels/types.js';
import { KeyedAsyncQueue } from '../../src/core/sessions/queue.js';
import { __resetRunRegistryForTest } from '../../src/core/agent/run-registry.js';
import { __resetSteerBufferForTest, getSteerBuffer } from '../../src/core/agent/steer-buffer.js';
import { __resetQueueModeStoreForTest, INTERRUPT_ACK_TEXT } from '../../src/core/channels/queue-modes.js';

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));
function ownerMsg(text: string): UnifiedMessage {
  return { id: Math.random().toString(36).slice(2), channel: 'signal', peerId: 'owner1', text, isOwner: true } as UnifiedMessage;
}
function strangerMsg(text: string): UnifiedMessage {
  return { id: Math.random().toString(36).slice(2), channel: 'signal', peerId: 'owner1', text, isOwner: false } as UnifiedMessage;
}
const MAIN_SESSION = 'sess:owner1';

interface Harness { handler: (m: UnifiedMessage) => Promise<void>; runs: Array<{ sid: string; text: string }>; sent: string[]; aborts: Array<{ sid: string; reason: string }>; releaseFirst: () => void; }

function harness(): Harness {
  const runs: Array<{ sid: string; text: string }> = [];
  const sent: string[] = [];
  const aborts: Array<{ sid: string; reason: string }> = [];
  let firstResolve: (() => void) | null = null;
  const releaseFirst = () => firstResolve?.();
  let call = 0;
  const deps: GatewayTurnDeps = {
    // Session id follows the peer key so a "#side" session differs from the main one.
    sessionManager: { getOrCreate: async (_ch: string, peer: string) => ({ id: `sess:${peer}` }), appendEvent: async () => {}, peerQueue: new KeyedAsyncQueue() },
    agentLoop: {
      run: vi.fn((sid: string, text: string) => {
        runs.push({ sid, text });
        call++;
        if (call === 1) return new Promise<{ text?: string }>((res) => { firstResolve = () => res({ text: 'A-done' }); });
        return Promise.resolve({ text: `answer:${text}` });
      }) as never,
    },
    runGenerations: { current: () => 0, isStale: () => false },
    send: async (_m, text) => { sent.push(text); },
    journal: false,
    serialize: false,
    abortRun: (sid, reason) => { aborts.push({ sid, reason }); releaseFirst(); },
  };
  return { handler: createGatewayTurnHandler(deps), runs, sent, aborts, releaseFirst };
}

beforeEach(() => {
  __resetRunRegistryForTest();
  __resetSteerBufferForTest();
  __resetQueueModeStoreForTest();
  process.env['SUDO_MIDRUN_STEER'] = '1';
  process.env['SUDO_QUEUE_MODE_DEFAULT'] = 'steer';
  delete process.env['SUDO_OWNER_MIDRUN'];
});
afterEach(() => {
  delete process.env['SUDO_MIDRUN_STEER'];
  delete process.env['SUDO_QUEUE_MODE_DEFAULT'];
  delete process.env['SUDO_OWNER_MIDRUN'];
  vi.restoreAllMocks();
});

describe('owner mid-run — default concurrent', () => {
  it('answers the 2nd owner message in the background WITHOUT interrupting the running task', async () => {
    const h = harness();
    const p1 = h.handler(ownerMsg('long autonomous task')); // main run, hangs
    await tick();
    const p2 = h.handler(ownerMsg('quick question')); // arrives mid-run
    await p2; // concurrent branch returns immediately after firing the side answer
    await tick(30);

    // The running task was NOT interrupted…
    expect(h.aborts.length).toBe(0);
    // …the quick question was answered on a SEPARATE side session…
    expect(h.runs.some((r) => r.text === 'quick question' && r.sid === 'sess:owner1#side')).toBe(true);
    expect(h.sent).toContain('answer:quick question');
    // …and it was NOT steered into the main run.
    expect(getSteerBuffer().size(MAIN_SESSION)).toBe(0);
    // The main run is still going; release it so the test ends cleanly.
    h.releaseFirst();
    await p1;
  });

  it('an UNTRUSTED mid-run message does NOT get a concurrent run (tier-guarded)', async () => {
    const h = harness();
    const p1 = h.handler(ownerMsg('owner task'));
    await tick();
    await h.handler(strangerMsg('stranger question'));
    await tick(20);
    // No interrupt, and no CONCURRENT side-session run for the untrusted message
    // (it is handled by the normal tier-guarded followup path, not the owner lane).
    expect(h.aborts.length).toBe(0);
    expect(h.runs.some((r) => r.sid === 'sess:owner1#side')).toBe(false);
    h.releaseFirst();
    await p1;
  });
});

describe('owner mid-run — SUDO_OWNER_MIDRUN=interrupt', () => {
  beforeEach(() => { process.env['SUDO_OWNER_MIDRUN'] = 'interrupt'; });

  it('aborts the running task and runs the new message, with an interrupt ack', async () => {
    const h = harness();
    const p1 = h.handler(ownerMsg('long task'));
    await tick();
    const p2 = h.handler(ownerMsg('do this instead'));
    await Promise.all([p1, p2]);
    await tick(30);
    expect(h.aborts.length).toBe(1);
    expect(h.aborts[0]).toMatchObject({ sid: MAIN_SESSION });
    expect(h.sent).toContain(INTERRUPT_ACK_TEXT);
    expect(h.runs.some((r) => r.text === 'do this instead')).toBe(true);
    expect(h.sent).toContain('answer:do this instead');
  });
});
