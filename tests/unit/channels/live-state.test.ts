/**
 * BO11 / S13 — live working-states. Verifies the pure phase/elapsed frame
 * builder: phases advance in order and never regress, elapsed is monotonic and
 * floored, the model/context chip is populated, and the Telegram progressive-edit
 * line formats correctly. Whimsy is injected (never the env) so output is pinned.
 */
import { describe, it, expect } from 'vitest';
import {
  nextPhase,
  elapsedSeconds,
  spinnerFrame,
  phaseLabel,
  formatModelContextChip,
  buildPhaseFrame,
  formatTelegramWorking,
  LiveStateTracker,
  PHASE_ORDER,
  type WorkPhase,
} from '../../../src/core/channels/live-state.js';
import type { AgentEvent } from '../../../src/core/agent/types.js';

const toolCall: AgentEvent = { type: 'tool-call', name: 'web.search', args: {}, toolId: 't1' };
const chunk: AgentEvent = { type: 'stream-chunk', chunk: 'hi' };
const done: AgentEvent = { type: 'done' };

describe('elapsedSeconds', () => {
  it('floors ms to whole seconds and never goes negative', () => {
    expect(elapsedSeconds(0)).toBe(0);
    expect(elapsedSeconds(999)).toBe(0);
    expect(elapsedSeconds(1000)).toBe(1);
    expect(elapsedSeconds(4200)).toBe(4);
    expect(elapsedSeconds(-500)).toBe(0);
    expect(elapsedSeconds(NaN)).toBe(0);
  });
});

describe('nextPhase — monotonic ordering', () => {
  it('advances waiting → running → streaming and never regresses', () => {
    expect(nextPhase('waiting', toolCall)).toBe('running');
    expect(nextPhase('running', chunk)).toBe('streaming');
    // a late tool-call after streaming must NOT drop back to running
    expect(nextPhase('streaming', toolCall)).toBe('streaming');
  });
  it('keeps phase on terminal/unknown events', () => {
    expect(nextPhase('running', done)).toBe('running');
    expect(nextPhase('waiting', { type: 'error', error: 'x' })).toBe('waiting');
  });
  it('stream-chunk jumps straight to streaming from waiting', () => {
    expect(nextPhase('waiting', chunk)).toBe('streaming');
  });
});

describe('phaseLabel — whimsy injected', () => {
  it('uses the plain phase word when whimsy is off', () => {
    expect(phaseLabel({ phase: 'waiting', whimsy: false })).toBe('waiting');
    expect(phaseLabel({ phase: 'running', whimsy: false })).toBe('running');
    expect(phaseLabel({ phase: 'streaming', whimsy: false })).toBe('streaming');
  });
  it('rotates a whimsical verb on the waiting phase when whimsy is on', () => {
    const l0 = phaseLabel({ phase: 'waiting', whimsy: true, verbIndex: 0 });
    const l1 = phaseLabel({ phase: 'waiting', whimsy: true, verbIndex: 1 });
    expect(l0.endsWith('…')).toBe(true);
    expect(l1.endsWith('…')).toBe(true);
    expect(l0).not.toBe(l1); // deterministic rotation
  });
  it('never whimsifies running/streaming even with whimsy on', () => {
    expect(phaseLabel({ phase: 'running', whimsy: true, verbIndex: 3 })).toBe('running');
    expect(phaseLabel({ phase: 'streaming', whimsy: true, verbIndex: 3 })).toBe('streaming');
  });
});

describe('formatModelContextChip', () => {
  it('joins model and context', () => {
    expect(formatModelContextChip('xai/grok-4.5', '21k/1.0m (2%)')).toBe('xai/grok-4.5 | 21k/1.0m (2%)');
  });
  it('falls back gracefully on empties', () => {
    expect(formatModelContextChip('', '')).toBe('unknown');
    expect(formatModelContextChip('m', '')).toBe('m');
  });
});

describe('buildPhaseFrame', () => {
  it('emits a phase frame with elapsedSec, label and chip populated', () => {
    const f = JSON.parse(
      buildPhaseFrame({ phase: 'running', elapsedMs: 4200, chip: 'xai/grok-4.5 | 21k/1.0m (2%)', whimsy: false }),
    );
    expect(f).toEqual({
      type: 'phase',
      phase: 'running',
      elapsedSec: 4,
      label: 'running',
      chip: 'xai/grok-4.5 | 21k/1.0m (2%)',
    });
  });
  it('omits chip when not supplied', () => {
    const f = JSON.parse(buildPhaseFrame({ phase: 'waiting', elapsedMs: 0, whimsy: false }));
    expect(f.chip).toBeUndefined();
    expect(f.label).toBe('waiting');
  });
});

describe('formatTelegramWorking', () => {
  it('builds a spinner + label + elapsed line with the chip on a second line', () => {
    const line = formatTelegramWorking({
      phase: 'streaming',
      elapsedMs: 2000,
      chip: 'xai/grok-4.5 | 21k/1.0m (2%)',
      whimsy: false,
      tick: 9,
    });
    expect(line).toBe('⠏ streaming • 2s\nxai/grok-4.5 | 21k/1.0m (2%)');
  });
  it('omits the chip line when no chip', () => {
    expect(formatTelegramWorking({ phase: 'running', elapsedMs: 1000, whimsy: false, tick: 0 })).toBe('⠋ running • 1s');
  });
});

describe('spinnerFrame', () => {
  it('wraps around the frame set for any integer', () => {
    expect(spinnerFrame(0)).toBe('⠋');
    expect(spinnerFrame(10)).toBe('⠋');
    expect(spinnerFrame(-1)).toBe('⠏');
  });
});

describe('LiveStateTracker', () => {
  it('emits an initial waiting frame then a frame only on phase change', () => {
    const t0 = 1_000_000;
    const tr = new LiveStateTracker({ startMs: t0, chip: 'm | c', verbIndex: 0, whimsy: false });
    const init = JSON.parse(tr.initialFrame(t0));
    expect(init).toMatchObject({ type: 'phase', phase: 'waiting', elapsedSec: 0, label: 'waiting', chip: 'm | c' });

    // stream-chunk before a tool call → jumps to streaming, one frame
    const f1 = tr.onEvent({ type: 'tool-call', name: 'x', args: {}, toolId: '1' }, t0 + 1500);
    expect(JSON.parse(f1!)).toMatchObject({ phase: 'running', elapsedSec: 1 });

    // another tool-call: same phase → null (no frame)
    expect(tr.onEvent({ type: 'tool-call', name: 'y', args: {}, toolId: '2' }, t0 + 2000)).toBeNull();

    // stream-chunk → streaming, new frame with monotonic elapsed
    const f2 = tr.onEvent({ type: 'stream-chunk', chunk: 'hi' }, t0 + 3200);
    expect(JSON.parse(f2!)).toMatchObject({ phase: 'streaming', elapsedSec: 3 });

    // late tool-call after streaming → no regression, no frame
    expect(tr.onEvent({ type: 'tool-call', name: 'z', args: {}, toolId: '3' }, t0 + 4000)).toBeNull();
    expect(tr.currentPhase).toBe('streaming');
  });

  it('keeps elapsed monotonic across the emitted frames', () => {
    const t0 = 0;
    const tr = new LiveStateTracker({ startMs: t0, whimsy: false });
    const frames: number[] = [JSON.parse(tr.initialFrame(t0)).elapsedSec];
    const f1 = tr.onEvent({ type: 'tool-call', name: 'a', args: {}, toolId: '1' }, 2500);
    frames.push(JSON.parse(f1!).elapsedSec);
    const f2 = tr.onEvent({ type: 'stream-chunk', chunk: 'x' }, 9100);
    frames.push(JSON.parse(f2!).elapsedSec);
    for (let i = 1; i < frames.length; i++) expect(frames[i]!).toBeGreaterThanOrEqual(frames[i - 1]!);
    expect(frames).toEqual([0, 2, 9]);
  });
});

describe('PHASE_ORDER', () => {
  it('is exactly waiting, running, streaming', () => {
    expect(PHASE_ORDER).toEqual<WorkPhase[]>(['waiting', 'running', 'streaming']);
  });
});
