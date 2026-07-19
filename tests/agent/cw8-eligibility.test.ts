/**
 * @file tests/agent/cw8-eligibility.test.ts
 * @description CW8 — eligibility traces for multi-step credit (SUDO_CAS_AGENCY).
 * Acceptance (handoff CW8): in a 3-step synthetic task where step-1's choice
 * causes step-3's failure, step-1's bias MOVES with traces and does NOT without.
 * Plus: decay/window mechanics, recordWeighted == record at weight 1, and the
 * flag-OFF path unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ToolSuccessStore, DEFAULT_ALPHA, DEFAULT_MIN_SAMPLES } from '../../src/core/agent/tool-success-store.js';
import { EligibilityTrace, resolveLambda, ELIGIBILITY_WINDOW } from '../../src/core/agent/eligibility-trace.js';

let dir: string;
let db: Database.Database;
const store = (): ToolSuccessStore => new ToolSuccessStore(db, { alpha: DEFAULT_ALPHA, minSamples: DEFAULT_MIN_SAMPLES });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cw8-')); db = new Database(join(dir, 'm.db')); });
afterEach(() => { try { db.close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); });

describe('CW8 — trace mechanics', () => {
  it('CW8-1: push decays priors by lambda and appends the newest at weight 1', () => {
    const t = new EligibilityTrace(0.7);
    t.push('A'); t.push('B'); t.push('C');
    const snap = t.snapshot();
    expect(snap.map((e) => e.tool)).toEqual(['A', 'B', 'C']);
    expect(snap[2]!.weight).toBeCloseTo(1, 6);        // newest
    expect(snap[1]!.weight).toBeCloseTo(0.7, 6);       // 1 step old
    expect(snap[0]!.weight).toBeCloseTo(0.49, 6);      // 2 steps old (lambda^2)
  });

  it('CW8-2: window is capped at ELIGIBILITY_WINDOW; negligible tails drop', () => {
    const t = new EligibilityTrace(0.7);
    for (let i = 0; i < 30; i++) t.push(`tool-${i}`);
    expect(t.snapshot().length).toBeLessThanOrEqual(ELIGIBILITY_WINDOW);
    expect(t.snapshot().at(-1)!.tool).toBe('tool-29'); // freshest retained
  });

  it('CW8-3: a recurring tool refreshes its eligibility to 1', () => {
    const t = new EligibilityTrace(0.7);
    t.push('A'); t.push('B'); t.push('A');
    const a = t.snapshot().find((e) => e.tool === 'A')!;
    expect(a.weight).toBeCloseTo(1, 6);
    expect(t.snapshot().length).toBe(2); // A deduped, not duplicated
  });

  it('CW8-4: default lambda is ~0.7, env-overridable within (0,1)', () => {
    expect(resolveLambda()).toBeCloseTo(0.7, 6);
    const saved = process.env['SUDO_CAS_ELIGIBILITY_LAMBDA'];
    process.env['SUDO_CAS_ELIGIBILITY_LAMBDA'] = '0.5';
    expect(resolveLambda()).toBeCloseTo(0.5, 6);
    process.env['SUDO_CAS_ELIGIBILITY_LAMBDA'] = '9'; // out of range -> default
    expect(resolveLambda()).toBeCloseTo(0.7, 6);
    if (saved === undefined) delete process.env['SUDO_CAS_ELIGIBILITY_LAMBDA'];
    else process.env['SUDO_CAS_ELIGIBILITY_LAMBDA'] = saved;
  });
});

describe('CW8 — recordWeighted extends the existing EMA (no new mechanism)', () => {
  it('CW8-5: weight 1 is identical to record(); a fractional weight moves less', () => {
    const a = store(); const b = store();
    a.record('coder.test', true); b.record('coder.test', true);      // seed both n=1 ema=1
    a.record('coder.test', false);                                    // full step
    b.recordWeighted('coder.test', false, 1);                         // weight 1 == full step
    expect(a.successRate('coder.test')).toBeCloseTo(b.successRate('coder.test')!, 9);

    const c = store();
    c.record('coder.test', true);
    const before = c.successRate('coder.test')!;
    c.recordWeighted('coder.test', false, 0.49);                      // fractional
    const drop = before - c.successRate('coder.test')!;
    expect(drop).toBeGreaterThan(0);
    expect(drop).toBeLessThan(DEFAULT_ALPHA * before); // less than a full step
  });
});

describe('CW8 — acceptance: 3-step credit reaches step 1', () => {
  it('CW8-6: step-1 choice causes step-3 failure — step-1 bias moves WITH traces, not WITHOUT', () => {
    // Seed step-1 tool with successes so its EMA sits in the unclamped band and
    // a small negative delta is observable.
    const withTraces = store();
    const without = store();
    for (let i = 0; i < 6; i++) { withTraces.record('coder.plan', true); without.record('coder.plan', true); }
    const step1Before = withTraces.successRate('coder.plan')!;
    expect(without.successRate('coder.plan')).toBeCloseTo(step1Before, 9);

    // 3-step task: plan (step1) -> edit (step2) -> test (step3, FAILS).
    const trace = new EligibilityTrace(0.7);
    trace.push('coder.plan');   // step 1
    trace.push('coder.edit-file'); // step 2
    trace.push('coder.test');   // step 3
    trace.distribute(withTraces, false); // outcome: failure at step 3

    // WITHOUT traces: only the last tool is credited (the pre-CW8 behavior).
    without.record('coder.test', false);

    const step1AfterWith = withTraces.successRate('coder.plan')!;
    const step1AfterWithout = without.successRate('coder.plan')!;

    expect(step1AfterWith).toBeLessThan(step1Before);        // moved WITH traces
    expect(step1AfterWithout).toBeCloseTo(step1Before, 9);   // unchanged WITHOUT
    // And step-3 got the full step in both (weight 1 == record).
    expect(withTraces.successRate('coder.test')).toBeCloseTo(without.successRate('coder.test')!, 9);
  });

  it('CW8-7: credit decays with distance — step-1 (lambda^2) moves less than step-2 (lambda^1)', () => {
    const s = store();
    for (const t of ['coder.plan', 'coder.edit-file']) for (let i = 0; i < 6; i++) s.record(t, true);
    const p1 = s.successRate('coder.plan')!;
    const p2 = s.successRate('coder.edit-file')!;
    const trace = new EligibilityTrace(0.7);
    trace.push('coder.plan'); trace.push('coder.edit-file'); trace.push('coder.test');
    trace.distribute(s, false);
    const d1 = p1 - s.successRate('coder.plan')!;      // step 1, weight lambda^2
    const d2 = p2 - s.successRate('coder.edit-file')!; // step 2, weight lambda^1
    expect(d1).toBeGreaterThan(0);
    expect(d2).toBeGreaterThan(d1); // nearer decision credited more
  });
});
