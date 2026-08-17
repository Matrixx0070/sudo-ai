/**
 * @file computer-core.test.ts
 * @description Phase 1 — deterministic unit tests for the Computer Use core
 * (grounding, executor closed loop + recovery ladder, journal, perception
 * helpers). No display required: perception + input are faked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroundingResolver } from '../../src/core/tools/builtin/computer-use/core/grounding.js';
import { ActionExecutor, type InputSink } from '../../src/core/tools/builtin/computer-use/core/executor.js';
import { ActionJournal } from '../../src/core/tools/builtin/computer-use/core/journal.js';
import { PerceptionService } from '../../src/core/tools/builtin/computer-use/core/perception.js';
import type { Snapshot, UIElement } from '../../src/core/tools/builtin/computer-use/core/types.js';

function el(over: Partial<UIElement>): UIElement {
  return { i: 0, role: 'push button', name: '', states: ['showing', 'enabled'], x: 0, y: 0, w: 40, h: 20, app: 'test', ...over };
}
function snap(seq: number, hash: string, elements: UIElement[] = [], windows: Snapshot['windows'] = []): Snapshot {
  return { seq, ts: seq, display: ':t', screenshot: '', width: 100, height: 100, hash, elements, windows, axAvailable: elements.length > 0 };
}

function queuePerception(snaps: Snapshot[]): PerceptionService {
  let idx = 0;
  const fake = {
    async capture() {
      const s = snaps[Math.min(idx, snaps.length - 1)];
      idx++;
      return s;
    },
  };
  return fake as unknown as PerceptionService;
}

function recordingSink(over: Partial<InputSink> = {}): { sink: InputSink; calls: string[] } {
  const calls: string[] = [];
  const ok = async () => ({ success: true });
  const sink: InputSink = {
    click: async (x, y) => { calls.push(`click:${x},${y}`); return { success: true }; },
    type: async (t) => { calls.push(`type:${t}`); return { success: true }; },
    key: async (k) => { calls.push(`key:${k}`); return { success: true }; },
    scroll: async (d) => { calls.push(`scroll:${d}`); return { success: true }; },
    doubleClick: ok,
    move: ok,
    focusWindow: ok,
    ...over,
  };
  return { sink, calls };
}

describe('GroundingResolver', () => {
  const els = [
    el({ i: 0, name: 'Cancel', x: 10, y: 10, w: 40, h: 20 }),
    el({ i: 1, name: 'OK', role: 'push button', x: 100, y: 10, w: 40, h: 20 }),
    el({ i: 2, name: 'OK Computer', role: 'label', x: 200, y: 10, w: 200, h: 20 }),
  ];
  const s = snap(0, 'h', els);
  const g = new GroundingResolver();

  it('resolves by element index to the element center', async () => {
    const r = await g.resolve({ elementIndex: 1 }, s);
    expect(r.source).toBe('element-index');
    expect(r.x).toBe(120); // 100 + 40/2
    expect(r.y).toBe(20);
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('prefers an exact + interactable name match over a substring label', async () => {
    const r = await g.resolve({ text: 'OK', role: 'push button' }, s);
    expect(r.source).toBe('ax-text');
    expect(r.element?.i).toBe(1); // the button, not the "OK Computer" label
  });

  it('falls back to explicit coordinates when no AX match', async () => {
    const r = await g.resolve({ text: 'ghost', x: 5, y: 6 }, s);
    expect(r.source).toBe('coords');
    expect(r).toMatchObject({ x: 5, y: 6 });
  });

  it('returns source "none" when nothing resolves', async () => {
    const r = await g.resolve({ text: 'ghost' }, s);
    expect(r.source).toBe('none');
    expect(r.x).toBeLessThan(0);
  });
});

describe('ActionExecutor closed loop', () => {
  beforeEach(() => { delete process.env['SUDO_AUTHORITY_MODE']; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('runs a plan to success when expectations are met', async () => {
    const perception = queuePerception([snap(0, 'A'), snap(1, 'B'), snap(2, 'B'), snap(3, 'C')]);
    const { sink, calls } = recordingSink();
    const exec = new ActionExecutor({ sessionId: 't', display: ':t', perception, grounding: new GroundingResolver(), sink, ownerVerified: true, settleMs: 0 });
    const res = await exec.run({ subgoal: 'x', actions: [
      { kind: 'click', target: { x: 5, y: 5 }, expect: { changed: true } },
      { kind: 'type', text: 'hi', expect: { changed: true } },
    ]});
    expect(res.success).toBe(true);
    expect(res.steps.map((s) => s.verdict)).toEqual(['ok', 'ok']);
    expect(calls).toEqual(['click:5,5', 'type:hi']);
  });

  it('recovers via the ladder when the first expectation fails', async () => {
    // attempt0: before A / after A (no change) → expectation-failed
    // attempt1 (reground): before A / after B (change) → ok
    const perception = queuePerception([snap(0, 'A'), snap(1, 'A'), snap(2, 'A'), snap(3, 'B')]);
    const { sink } = recordingSink();
    const exec = new ActionExecutor({ sessionId: 't', display: ':t', perception, grounding: new GroundingResolver(), sink, ownerVerified: true, settleMs: 0 });
    const res = await exec.run({ subgoal: 'x', actions: [{ kind: 'click', target: { x: 1, y: 1 }, expect: { changed: true } }] });
    expect(res.success).toBe(true);
    expect(res.steps[0].recovery).toEqual(['reground']);
  });

  it('walks the grounding-failure ladder and escalates when exhausted', async () => {
    const perception = queuePerception([snap(0, 'A')]);
    const { sink } = recordingSink();
    let escalated = false;
    const exec = new ActionExecutor({ sessionId: 't', display: ':t', perception, grounding: new GroundingResolver(), sink, ownerVerified: true, settleMs: 0, maxRecoveries: 3, onEscalate: async () => { escalated = true; } });
    const res = await exec.run({ subgoal: 'x', actions: [{ kind: 'click', target: { text: 'ghost' }, expect: { changed: true } }] });
    expect(res.success).toBe(false);
    expect(res.steps[0].verdict).toBe('grounding-failed');
    expect(res.steps[0].recovery).toContain('escalate');
    expect(escalated).toBe(true);
  });

  it('refuses mutating actions in gated authority mode', async () => {
    process.env['SUDO_AUTHORITY_MODE'] = 'gated';
    const perception = queuePerception([snap(0, 'A'), snap(1, 'A')]);
    const { sink, calls } = recordingSink();
    const exec = new ActionExecutor({ sessionId: 't', display: ':t', perception, grounding: new GroundingResolver(), sink, ownerVerified: true, settleMs: 0, maxRecoveries: 0 });
    const res = await exec.run({ subgoal: 'x', actions: [{ kind: 'type', text: 'hi' }] });
    expect(res.success).toBe(false);
    expect(res.steps[0].verdict).toBe('refused');
    expect(calls.length).toBe(0);
  });

  it('verifies element appears/disappears expectations against the AX tree', async () => {
    const before = snap(0, 'A', [el({ i: 0, name: 'Open' })]);
    const after = snap(1, 'B', [el({ i: 0, name: 'Save' })]);
    const perception = queuePerception([before, after]);
    const { sink } = recordingSink();
    const exec = new ActionExecutor({ sessionId: 't', display: ':t', perception, grounding: new GroundingResolver(), sink, ownerVerified: true, settleMs: 0, maxRecoveries: 0 });
    const res = await exec.run({ subgoal: 'x', actions: [{ kind: 'key', key: 'ctrl+s', expect: { appears: 'Save', disappears: 'Open' } }] });
    expect(res.success).toBe(true);
  });
});

describe('ActionJournal', () => {
  it('appends one JSONL entry per recorded step', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cu-jtest-'));
    const j = new ActionJournal('sess-1', ':t', dir);
    await j.record('sub', {
      action: { kind: 'click', label: 'x' }, verdict: 'ok', recovery: [], beforeSeq: 0, afterSeq: 1, durationMs: 5, message: 'ok',
    }, 'h0', 'h1');
    const txt = await readFile(j.filePath, 'utf8');
    const lines = txt.trim().split('\n');
    expect(lines.length).toBe(1);
    const e = JSON.parse(lines[0]);
    expect(e).toMatchObject({ subgoal: 'sub', verdict: 'ok', beforeHash: 'h0', afterHash: 'h1' });
  });
});

describe('PerceptionService.changed', () => {
  it('is true only when screenshot hashes differ', () => {
    expect(PerceptionService.changed(snap(0, 'A'), snap(1, 'A'))).toBe(false);
    expect(PerceptionService.changed(snap(0, 'A'), snap(1, 'B'))).toBe(true);
  });
});
