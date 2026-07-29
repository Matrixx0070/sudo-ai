/**
 * @file tests/unit/channels/telegram-run-controls.test.ts
 * @description TX1/TX2 pure pieces: stop/reason callback-data round-trips,
 * stopped-card rendering, the one-regen-per-feedbackId guard, the revision
 * instruction, and the dependency-injected callback dispatcher (grammy-free,
 * house pattern per telegram-command-intercept.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  STOP_CALLBACK_PREFIX,
  makeStopKeyboard,
  parseStopCallback,
  renderStoppedCard,
  REASON_CALLBACK_PREFIX,
  makeReasonKeyboard,
  parseReasonCallback,
  REGEN_REASON_LABELS,
  RegenGuard,
  buildRegenInstruction,
  handleRunControlCallback,
  wantsReasonKeyboard,
  type RegenerateRequest,
  type RunControlCtx,
  type RunControlDeps,
} from '../../../src/core/channels/telegram-run-controls.js';

// ---------------------------------------------------------------------------
// TX1 — stop callback data
// ---------------------------------------------------------------------------

describe('stop callback data', () => {
  it('keyboard carries tx1:stop:<runKey> on a single ⏹ button', () => {
    const kb = makeStopKeyboard('telegram:123456789');
    const rows = kb.inline_keyboard;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    const btn = rows[0]![0]! as { text: string; callback_data: string };
    expect(btn.text).toBe('⏹ Stop');
    expect(btn.callback_data).toBe('tx1:stop:telegram:123456789');
    // Telegram caps callback data at 64 bytes.
    expect(Buffer.byteLength(btn.callback_data)).toBeLessThanOrEqual(64);
  });

  it('parseStopCallback round-trips run keys, including embedded colons', () => {
    expect(parseStopCallback(`${STOP_CALLBACK_PREFIX}telegram:42`)).toBe('telegram:42');
    expect(parseStopCallback('tx1:stop:a:b:c')).toBe('a:b:c');
  });

  it('rejects non-stop and empty data', () => {
    expect(parseStopCallback('fb:good:xyz')).toBeNull();
    expect(parseStopCallback('tx1:stop:')).toBeNull();
    expect(parseStopCallback('tx2:reason:id:wrong')).toBeNull();
    expect(parseStopCallback('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TX1 — stopped card
// ---------------------------------------------------------------------------

describe('renderStoppedCard', () => {
  it('renders elapsed + step count', () => {
    expect(renderStoppedCard({ elapsedMs: 40_000, steps: 3 })).toBe('⏹ Stopped • 40s • 3 steps');
  });

  it('singularizes one step and omits zero steps', () => {
    expect(renderStoppedCard({ elapsedMs: 5_000, steps: 1 })).toBe('⏹ Stopped • 5s • 1 step');
    expect(renderStoppedCard({ elapsedMs: 5_000, steps: 0 })).toBe('⏹ Stopped • 5s');
  });

  it('formats past a minute like the timeline (1m 05s) and clamps bad input', () => {
    expect(renderStoppedCard({ elapsedMs: 65_000, steps: 0 })).toBe('⏹ Stopped • 1m 05s');
    expect(renderStoppedCard({ elapsedMs: -50, steps: 0 })).toBe('⏹ Stopped • 0s');
    expect(renderStoppedCard({ elapsedMs: Number.NaN, steps: 0 })).toBe('⏹ Stopped • 0s');
  });
});

// ---------------------------------------------------------------------------
// TX2 — reason callback data
// ---------------------------------------------------------------------------

describe('reason callback data', () => {
  const fid = '123e4567-e89b-12d3-a456-426614174000';

  it('keyboard offers the four reasons with parseable, <=64-byte data', () => {
    const kb = makeReasonKeyboard(fid);
    const buttons = kb.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>;
    expect(buttons.map((b) => b.text)).toEqual(['Wrong', 'Too long', 'Missed the point', 'Skip reasons']);
    for (const b of buttons) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
      const parsed = parseReasonCallback(b.callback_data);
      expect(parsed?.feedbackId).toBe(fid);
    }
    expect(buttons.map((b) => parseReasonCallback(b.callback_data)?.code)).toEqual(['wrong', 'long', 'missed', 'skip']);
  });

  it('rejects unknown codes, empty ids, and foreign prefixes', () => {
    expect(parseReasonCallback(`${REASON_CALLBACK_PREFIX}${fid}:nope`)).toBeNull();
    expect(parseReasonCallback(`${REASON_CALLBACK_PREFIX}:wrong`)).toBeNull();
    expect(parseReasonCallback('fb:bad:xyz')).toBeNull();
    expect(parseReasonCallback('tx1:stop:telegram:1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TX2 — regen guard
// ---------------------------------------------------------------------------

describe('RegenGuard', () => {
  it('grants exactly one regeneration per feedbackId', () => {
    const g = new RegenGuard();
    expect(g.tryAcquire('a')).toBe(true);
    expect(g.tryAcquire('a')).toBe(false);
    expect(g.tryAcquire('b')).toBe(true);
  });

  it('rejects empty ids and stays bounded past the cap', () => {
    const g = new RegenGuard(4);
    expect(g.tryAcquire('')).toBe(false);
    for (let i = 0; i < 4; i++) expect(g.tryAcquire(`id${i}`)).toBe(true);
    expect(g.tryAcquire('overflow')).toBe(true); // eviction, not refusal
    expect(g.tryAcquire('overflow')).toBe(false); // still once each
  });
});

// ---------------------------------------------------------------------------
// TX2 — revision instruction
// ---------------------------------------------------------------------------

describe('buildRegenInstruction', () => {
  it('carries the rejected reply and the reason', () => {
    const s = buildRegenInstruction({ originalText: 'The capital of France is Berlin.', reason: 'Wrong' });
    expect(s).toContain('The capital of France is Berlin.');
    expect(s).toContain('Reason: Wrong.');
    expect(s).toContain('revised answer');
  });

  it('omits the reason when skipped and survives empty originals', () => {
    const skipped = buildRegenInstruction({ originalText: 'x', reason: REGEN_REASON_LABELS.skip });
    expect(skipped).not.toContain('Reason:');
    const empty = buildRegenInstruction({ originalText: '', reason: '' });
    expect(empty).toContain('(original text unavailable)');
  });

  it('truncates very long originals', () => {
    const s = buildRegenInstruction({ originalText: 'a'.repeat(10_000), reason: 'Too long' });
    expect(s.length).toBeLessThan(4_000);
  });
});

// ---------------------------------------------------------------------------
// Callback dispatcher (handler tests — no grammy)
// ---------------------------------------------------------------------------

function makeCtx(data: string, over: Partial<RunControlCtx> = {}): RunControlCtx & { answers: string[]; markups: unknown[] } {
  const answers: string[] = [];
  const markups: unknown[] = [];
  return {
    data,
    fromId: 'owner1',
    chatId: 'chat1',
    messageId: 77,
    messageText: 'the rejected reply',
    async answer(text?: string) { answers.push(text ?? ''); },
    async editReplyMarkup(kb) { markups.push(kb); },
    answers,
    markups,
    ...over,
  };
}

function makeDeps(over: Partial<RunControlDeps> = {}): RunControlDeps {
  return {
    env: { SUDO_TG_STOP_BUTTON: '1', SUDO_TG_BAD_REGEN: '1' } as NodeJS.ProcessEnv,
    isOwner: (id) => id === 'owner1',
    getActiveRun: () => undefined,
    guard: new RegenGuard(),
    onRegenerate: null,
    ...over,
  };
}

describe('handleRunControlCallback — TX1 stop', () => {
  it('owner tap aborts the active run and acks Stopping', async () => {
    const abort = vi.fn();
    const ctx = makeCtx('tx1:stop:telegram:1');
    const consumed = await handleRunControlCallback(ctx, makeDeps({ getActiveRun: (k) => (k === 'telegram:1' ? { abort } : undefined) }));
    expect(consumed).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(ctx.answers[0]).toContain('Stopping');
  });

  it('non-owner tap is refused without aborting', async () => {
    const abort = vi.fn();
    const ctx = makeCtx('tx1:stop:telegram:1', { fromId: 'stranger' });
    await handleRunControlCallback(ctx, makeDeps({ getActiveRun: () => ({ abort }) }));
    expect(abort).not.toHaveBeenCalled();
    expect(ctx.answers[0]).toContain('owner');
  });

  it('flag OFF refuses; missing run answers "No active run"', async () => {
    const ctx1 = makeCtx('tx1:stop:telegram:1');
    await handleRunControlCallback(ctx1, makeDeps({ env: {} as NodeJS.ProcessEnv }));
    expect(ctx1.answers[0]).toContain('not enabled');

    const ctx2 = makeCtx('tx1:stop:telegram:1');
    await handleRunControlCallback(ctx2, makeDeps({ getActiveRun: () => undefined }));
    expect(ctx2.answers[0]).toContain('No active run');
  });

  it('foreign callback data is not consumed', async () => {
    expect(await handleRunControlCallback(makeCtx('fb:good:x'), makeDeps())).toBe(false);
    expect(await handleRunControlCallback(makeCtx('anything'), makeDeps())).toBe(false);
  });
});

describe('handleRunControlCallback — TX2 reasons', () => {
  const fid = 'feed-1';

  it('owner reason tap fires the regen seam with reply text + reason label', async () => {
    const seen: RegenerateRequest[] = [];
    const ctx = makeCtx(`tx2:reason:${fid}:wrong`);
    const consumed = await handleRunControlCallback(ctx, makeDeps({ onRegenerate: (r) => { seen.push(r); } }));
    expect(consumed).toBe(true);
    await Promise.resolve(); // fire-and-forget settles
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      peerId: 'owner1', chatId: 'chat1', messageId: 77, feedbackId: fid,
      reason: 'Wrong', originalText: 'the rejected reply',
    });
    expect(ctx.markups[0]).toBeUndefined(); // reason keyboard removed
    expect(ctx.answers[0]).toContain('Regenerating');
  });

  it('skip-reasons tap regenerates with an empty reason', async () => {
    const seen: RegenerateRequest[] = [];
    await handleRunControlCallback(makeCtx(`tx2:reason:${fid}:skip`), makeDeps({ onRegenerate: (r) => { seen.push(r); } }));
    await Promise.resolve();
    expect(seen[0]?.reason).toBe('');
  });

  it('guard allows exactly one regen per feedbackId', async () => {
    const onRegenerate = vi.fn();
    const deps = makeDeps({ onRegenerate });
    const first = makeCtx(`tx2:reason:${fid}:long`);
    const second = makeCtx(`tx2:reason:${fid}:wrong`);
    await handleRunControlCallback(first, deps);
    await handleRunControlCallback(second, deps);
    await Promise.resolve();
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(second.answers[0]).toContain('Already regenerated');
  });

  it('flag OFF or non-owner refuses; records the reason marker when granted', async () => {
    const recorded: Array<[string, string]> = [];
    const offCtx = makeCtx(`tx2:reason:${fid}:wrong`);
    await handleRunControlCallback(offCtx, makeDeps({ env: {} as NodeJS.ProcessEnv, onRegenerate: vi.fn() }));
    expect(offCtx.answers[0]).toContain('Not available');

    const strangerCtx = makeCtx(`tx2:reason:${fid}:wrong`, { fromId: 'stranger' });
    await handleRunControlCallback(strangerCtx, makeDeps({ onRegenerate: vi.fn() }));
    expect(strangerCtx.answers[0]).toContain('Not available');

    await handleRunControlCallback(
      makeCtx(`tx2:reason:${fid}:missed`),
      makeDeps({ onRegenerate: vi.fn(), recordReason: (id, code) => { recorded.push([id, code]); } }),
    );
    expect(recorded).toEqual([[fid, 'missed']]);
  });

  it('no regen seam wired → answers unavailable (after consuming the guard)', async () => {
    const ctx = makeCtx(`tx2:reason:${fid}:wrong`);
    await handleRunControlCallback(ctx, makeDeps({ onRegenerate: null }));
    expect(ctx.answers[0]).toContain('unavailable');
  });
});

describe('wantsReasonKeyboard', () => {
  const env = { SUDO_TG_BAD_REGEN: '1' } as NodeJS.ProcessEnv;

  it('true only for flag-on + bad + owner + handler', () => {
    expect(wantsReasonKeyboard({ env, rating: 'bad', isOwnerUser: true, hasRegenHandler: true })).toBe(true);
    expect(wantsReasonKeyboard({ env: {} as NodeJS.ProcessEnv, rating: 'bad', isOwnerUser: true, hasRegenHandler: true })).toBe(false);
    expect(wantsReasonKeyboard({ env, rating: 'good', isOwnerUser: true, hasRegenHandler: true })).toBe(false);
    expect(wantsReasonKeyboard({ env, rating: 'bad', isOwnerUser: false, hasRegenHandler: true })).toBe(false);
    expect(wantsReasonKeyboard({ env, rating: 'bad', isOwnerUser: true, hasRegenHandler: false })).toBe(false);
  });
});
