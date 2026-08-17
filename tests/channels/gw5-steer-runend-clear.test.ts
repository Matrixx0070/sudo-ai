/**
 * @file tests/channels/gw5-steer-runend-clear.test.ts
 * @description GW-5 MEDIUM-1 (updated): a steer that lands after the loop's final
 * drain but before run-end must NOT silently vanish, and must NOT leak into the
 * next unrelated run as an injected steer. The turn handler now RE-DELIVERS it as
 * its own fresh turn — so the owner's mid-run message is always followed and
 * answered (fixes the "bot ignores the current message and keeps running the old
 * loop" bug), while the steer buffer is left empty for the next run.
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

function makeDeps(
  runImpl: (sessionId: string, text: string) => Promise<{ text?: string }>,
  sent: string[],
): GatewayTurnDeps {
  return {
    sessionManager: {
      getOrCreate: async () => ({ id: SESSION_ID }),
      appendEvent: async () => {},
      peerQueue: new KeyedAsyncQueue(),
    },
    agentLoop: { run: vi.fn((sid: string, text: string) => runImpl(sid, text)) as never },
    runGenerations: { current: () => 0, isStale: () => false },
    send: async (_m, text) => { sent.push(text); },
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

describe('GW-5 run-end orphaned steer → re-delivered as a fresh turn (never dropped)', () => {
  it('re-delivers an orphaned mid-run message as its own turn and answers it', async () => {
    const d = deferred();
    const runTexts: string[] = [];
    const sent: string[] = [];
    let call = 0;
    const handler = createGatewayTurnHandler(
      makeDeps((_sid, text) => {
        runTexts.push(text);
        call++;
        // First run (the "old loop") hangs so the steer lands mid-run; the
        // re-delivered turn resolves immediately.
        return call === 1 ? d.promise : Promise.resolve({ text: `answer:${text}` });
      }, sent),
    );

    // Run A starts and hangs (the long "old loop").
    const runA = handler(msg('long task'));
    await tick();

    // A message lands mid-run and slips past the loop's final drain (simulated by
    // pushing directly into the active session's steer buffer).
    getSteerBuffer().push(SESSION_ID, 'take a screenshot', 'owner');
    expect(getSteerBuffer().size(SESSION_ID)).toBe(1);

    // Run A completes → finally re-delivers the orphaned message as a new turn.
    d.resolve({ text: 'A done' });
    await runA;
    await tick(40); // let the re-delivered turn drain off the peer queue

    // Buffer is empty (drained, not left to leak into the next run).
    expect(getSteerBuffer().size(SESSION_ID)).toBe(0);
    // The orphaned message was RE-DELIVERED as its own turn (not discarded)…
    expect(runTexts).toContain('take a screenshot');
    // …and answered.
    expect(sent).toContain('answer:take a screenshot');
  });

  it('does nothing when there is no orphaned message', async () => {
    const sent: string[] = [];
    const handler = createGatewayTurnHandler(makeDeps(async (_sid, _t) => ({ text: 'ok' }), sent));
    await handler(msg('hello'));
    await tick(30);
    expect(getSteerBuffer().size(SESSION_ID)).toBe(0);
    expect(sent).toEqual(['ok']); // exactly one turn, no phantom re-delivery
  });
});
