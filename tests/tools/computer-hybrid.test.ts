/**
 * @file computer-hybrid.test.ts
 * @description Phase 3 — speculative batch execution (abort + fewer perception
 * round-trips), the structured (AX) action path, and the snapshot cache.
 * Deterministic, no display.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ActionExecutor, type InputSink } from '../../src/core/tools/builtin/computer-use/core/executor.js';
import { GroundingResolver } from '../../src/core/tools/builtin/computer-use/core/grounding.js';
import { PerceptionService } from '../../src/core/tools/builtin/computer-use/core/perception.js';
import type { Snapshot, UIElement, Action } from '../../src/core/tools/builtin/computer-use/core/types.js';

function el(over: Partial<UIElement>): UIElement {
  return { i: 0, role: 'push button', name: '', states: ['showing', 'enabled'], x: 0, y: 0, w: 40, h: 20, app: 'test', ...over };
}
function snap(seq: number, hash: string, elements: UIElement[] = []): Snapshot {
  return { seq, ts: seq, display: ':t', screenshot: '', width: 100, height: 100, hash, elements, windows: [], axAvailable: elements.length > 0 };
}

function countingPerception(snaps: Snapshot[]): { perception: PerceptionService; captures: () => number } {
  let idx = 0;
  let captureCount = 0;
  const fake = {
    async capture() { captureCount++; const s = snaps[Math.min(idx, snaps.length - 1)]; idx++; return s; },
    invalidate() {},
  };
  return { perception: fake as unknown as PerceptionService, captures: () => captureCount };
}

function recordingSink(): { sink: InputSink; calls: string[] } {
  const calls: string[] = [];
  const ok = async () => ({ success: true });
  return {
    calls,
    sink: {
      click: async (x, y) => { calls.push(`click:${x},${y}`); return { success: true }; },
      type: async (t) => { calls.push(`type:${t}`); return { success: true }; },
      key: async (k) => { calls.push(`key:${k}`); return { success: true }; },
      scroll: async (d) => { calls.push(`scroll:${d}`); return { success: true }; },
      doubleClick: ok, move: ok, focusWindow: ok,
    },
  };
}

describe('speculative batch execution', () => {
  beforeEach(() => { delete process.env['SUDO_AUTHORITY_MODE']; });

  it('verifies only at checkpoints — far fewer perception captures than per-action', async () => {
    // 3 actions, only the last carries an expect.
    const actions: Action[] = [
      { kind: 'type', text: 'a' },
      { kind: 'type', text: 'b' },
      { kind: 'key', key: 'Return', expect: { changed: true } },
    ];
    const batchP = countingPerception([snap(0, 'A'), snap(1, 'B')]);
    const { sink } = recordingSink();
    const be = new ActionExecutor({ sessionId: 't', display: ':t', perception: batchP.perception, grounding: new GroundingResolver(), sink, ownerVerified: true, settleMs: 0 });
    const br = await be.runBatch({ subgoal: 'x', actions });
    expect(br.success).toBe(true);
    // before(1) + one checkpoint(1) = 2
    expect(batchP.captures()).toBe(2);

    // Same plan via verified run(): before+after per action = 6 captures.
    const verP = countingPerception([snap(0, 'A'), snap(1, 'B'), snap(2, 'C'), snap(3, 'D'), snap(4, 'E'), snap(5, 'F')]);
    const ve = new ActionExecutor({ sessionId: 't', display: ':t', perception: verP.perception, grounding: new GroundingResolver(), sink: recordingSink().sink, ownerVerified: true, settleMs: 0 });
    await ve.run({ subgoal: 'x', actions });
    expect(verP.captures()).toBeGreaterThan(batchP.captures());
    // >=30% fewer captures in batch mode.
    expect(batchP.captures()).toBeLessThanOrEqual(verP.captures() * 0.7);
  });

  it('aborts the batch on a failed checkpoint expectation and does not run later actions', async () => {
    const actions: Action[] = [
      { kind: 'type', text: 'a', expect: { changed: true } }, // checkpoint fails (no change)
      { kind: 'type', text: 'b' },
    ];
    const p = countingPerception([snap(0, 'A'), snap(1, 'A')]); // after == before → not changed
    const { sink, calls } = recordingSink();
    const e = new ActionExecutor({ sessionId: 't', display: ':t', perception: p.perception, grounding: new GroundingResolver(), sink, ownerVerified: true, settleMs: 0 });
    const r = await e.runBatch({ subgoal: 'x', actions });
    expect(r.success).toBe(false);
    expect(r.reason).toBe('expectation-failed');
    expect(r.steps.length).toBe(1); // aborted before the second action
    expect(calls).toEqual(['type:a']); // 'b' never typed
  });
});

describe('structured (AX) action path', () => {
  beforeEach(() => { delete process.env['SUDO_AUTHORITY_MODE']; });

  it('performs a grounded click via the structured actor instead of a pixel click', async () => {
    const els = [el({ i: 0, name: 'Save', role: 'push button', x: 10, y: 10, w: 40, h: 20 })];
    const p = countingPerception([snap(0, 'A', els), snap(1, 'B', els)]);
    const { sink, calls } = recordingSink();
    let structuredCalls = 0;
    const exec = new ActionExecutor({
      sessionId: 't', display: ':t', perception: p.perception, grounding: new GroundingResolver(), sink,
      ownerVerified: true, settleMs: 0,
      structuredActor: async () => { structuredCalls++; return true; },
    });
    const res = await exec.run({ subgoal: 'x', actions: [{ kind: 'click', target: { text: 'Save' }, expect: { changed: true } }] });
    expect(res.success).toBe(true);
    expect(res.steps[0].structured).toBe(true);
    expect(structuredCalls).toBe(1);
    expect(calls.filter((c) => c.startsWith('click'))).toEqual([]); // no pixel click
  });

  it('falls back to a pixel click when the structured actor declines', async () => {
    const els = [el({ i: 0, name: 'Save', role: 'push button', x: 10, y: 10, w: 40, h: 20 })];
    const p = countingPerception([snap(0, 'A', els), snap(1, 'B', els)]);
    const { sink, calls } = recordingSink();
    const exec = new ActionExecutor({
      sessionId: 't', display: ':t', perception: p.perception, grounding: new GroundingResolver(), sink,
      ownerVerified: true, settleMs: 0,
      structuredActor: async () => false,
    });
    const res = await exec.run({ subgoal: 'x', actions: [{ kind: 'click', target: { text: 'Save' }, expect: { changed: true } }] });
    expect(res.success).toBe(true);
    expect(res.steps[0].structured).toBeFalsy();
    expect(calls.some((c) => c.startsWith('click'))).toBe(true);
  });
});

describe('snapshot cache', () => {
  it('reuses a snapshot within the TTL and re-captures after invalidate', async () => {
    const perc = new PerceptionService({ accessibility: false });
    const fake = snap(0, 'A');
    const spy = vi.spyOn(perc, 'capture').mockResolvedValue(fake);
    await perc.captureCached(':t', 1000);
    await perc.captureCached(':t', 1000); // cached — no new capture
    expect(spy).toHaveBeenCalledTimes(1);
    perc.invalidate(':t');
    await perc.captureCached(':t', 1000); // re-captures
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
