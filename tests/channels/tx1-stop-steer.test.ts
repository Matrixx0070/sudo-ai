/**
 * @file tests/channels/tx1-stop-steer.test.ts
 * @description TX1 wiring-shape integration (mirrors gw5-turn-steer.test.ts):
 * the cli.ts Telegram path registers a run whose abort seam signals the loop's
 * steering channel; a ⏹ Stop callback resolved through the REAL run-registry
 * lands an 'abort' steering signal (honored by the loop at its next iteration
 * boundary); and the pre-coalescer steer decision matches gateway semantics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRunRegistryForTest, getRunRegistry } from '../../src/core/agent/run-registry.js';
import { __resetSteerBufferForTest, getSteerBuffer } from '../../src/core/agent/steer-buffer.js';
import { decideQueueMode } from '../../src/core/channels/queue-modes.js';
import { InMemorySteeringChannel } from '../../src/core/agent/steering.js';
import { handleRunControlCallback, RegenGuard } from '../../src/core/channels/telegram-run-controls.js';

beforeEach(() => {
  __resetRunRegistryForTest();
  __resetSteerBufferForTest();
});

/** The exact registration shape cli.ts handleTelegramTurn uses under TX1. */
function registerCliStyleRun(steering: InMemorySteeringChannel, opts: { convKey: string; sessionId: string; onAbort?: () => void }): void {
  getRunRegistry().beginRun({
    key: opts.convKey,
    sessionId: opts.sessionId,
    tier: 'owner',
    abort: (reason) => {
      opts.onAbort?.();
      steering.signal(opts.sessionId, { action: 'abort', payload: reason });
    },
  });
}

describe('TX1 stop → run-registry → steering channel', () => {
  it('an owner ⏹ tap lands an abort steering signal for the run session', async () => {
    const steering = new InMemorySteeringChannel();
    let stopFlagged = false;
    registerCliStyleRun(steering, { convKey: 'telegram:42', sessionId: 'sess-42', onAbort: () => { stopFlagged = true; } });

    const answers: string[] = [];
    const consumed = await handleRunControlCallback(
      {
        data: 'tx1:stop:telegram:42',
        fromId: 'owner1',
        async answer(t?: string) { answers.push(t ?? ''); },
        async editReplyMarkup() { /* noop */ },
      },
      {
        env: { SUDO_TG_STOP_BUTTON: '1' } as NodeJS.ProcessEnv,
        isOwner: (id) => id === 'owner1',
        getActiveRun: (key) => getRunRegistry().get(key),
        guard: new RegenGuard(),
        onRegenerate: null,
      },
    );

    expect(consumed).toBe(true);
    expect(stopFlagged).toBe(true);
    const sig = steering.checkSteering('sess-42');
    expect(sig?.action).toBe('abort');
    expect(sig?.payload).toContain('stopped by owner');
    expect(answers[0]).toContain('Stopping');
  });

  it('endRun makes a later stop tap a no-op (stale button)', async () => {
    const steering = new InMemorySteeringChannel();
    registerCliStyleRun(steering, { convKey: 'telegram:42', sessionId: 'sess-42' });
    getRunRegistry().endRun('telegram:42');

    const answers: string[] = [];
    await handleRunControlCallback(
      { data: 'tx1:stop:telegram:42', fromId: 'owner1', async answer(t?: string) { answers.push(t ?? ''); }, async editReplyMarkup() {} },
      {
        env: { SUDO_TG_STOP_BUTTON: '1' } as NodeJS.ProcessEnv,
        isOwner: () => true,
        getActiveRun: (key) => getRunRegistry().get(key),
        guard: new RegenGuard(),
        onRegenerate: null,
      },
    );
    expect(steering.checkSteering('sess-42')).toBeNull();
    expect(answers[0]).toContain('No active run');
  });
});

describe('TX1 pre-coalescer steer decision (gateway-semantics mirror)', () => {
  it('active owner run + steer mode → message goes to the steer buffer keyed by sessionId', () => {
    getRunRegistry().beginRun({ key: 'telegram:7', sessionId: 'sess-7', tier: 'owner' });
    const active = getRunRegistry().get('telegram:7')!;
    const decision = decideQueueMode({
      mode: 'steer', activeRun: true, isMedia: false, isCommand: false,
      runTier: active.tier, msgTier: 'owner',
    });
    expect(decision).toEqual({ action: 'steer', tier: 'owner' });
    if (decision.action === 'steer') getSteerBuffer().push(active.sessionId, 'also check the docs', decision.tier);
    const drained = getSteerBuffer().drain('sess-7');
    expect(drained).toHaveLength(1);
    expect(drained[0]!.text).toBe('also check the docs');
  });

  it('untrusted message never steers an owner run; media never steers', () => {
    expect(decideQueueMode({ mode: 'steer', activeRun: true, isMedia: false, isCommand: false, runTier: 'owner', msgTier: 'untrusted' }))
      .toEqual({ action: 'followup' });
    expect(decideQueueMode({ mode: 'steer', activeRun: true, isMedia: true, isCommand: false, runTier: 'owner', msgTier: 'owner' }))
      .toEqual({ action: 'followup' });
  });

  it('default queue mode (followup) leaves the coalescer path untouched', () => {
    expect(decideQueueMode({ mode: 'followup', activeRun: true, isMedia: false, isCommand: false, runTier: 'owner', msgTier: 'owner' }))
      .toEqual({ action: 'followup' });
  });
});
