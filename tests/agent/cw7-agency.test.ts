/**
 * @file tests/agent/cw7-agency.test.ts
 * @description CW7 — cheap agency / efference (SUDO_CAS_AGENCY, default OFF).
 * Acceptance (handoff CW7): repeated mismatches on a synthetic failing tool
 * measurably lower its bias AND trip a doom-loop warning earlier than without.
 * Plus: scope gate (only coder.* + system.exec), expectation capture, the
 * penalize nudge stays <= one EMA step, mismatch counter for Telemetry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ToolSuccessStore, DEFAULT_ALPHA, DEFAULT_MIN_SAMPLES } from '../../src/core/agent/tool-success-store.js';
import { DoomLoopDetector, DOOM_LOOP_THRESHOLD } from '../../src/core/agent/doom-loop.js';
import { AgencyMonitor, captureExpectation, isInScope } from '../../src/core/agent/agency-monitor.js';

let dir: string;
let db: Database.Database;
function freshStore(): ToolSuccessStore {
  return new ToolSuccessStore(db, { alpha: DEFAULT_ALPHA, minSamples: DEFAULT_MIN_SAMPLES });
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cw7-')); db = new Database(join(dir, 'm.db')); });
afterEach(() => { try { db.close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); });

describe('CW7 — scope + expectation capture', () => {
  it('CW7-1: in-scope = coder.* and system.exec only', () => {
    expect(isInScope('system.exec')).toBe(true);
    expect(isInScope('coder.edit-file')).toBe(true);
    expect(isInScope('web.fetch')).toBe(false);
    expect(isInScope('canvas.render')).toBe(false);
  });

  it('CW7-2: captureExpectation returns success-expectation for in-scope, null otherwise', () => {
    expect(captureExpectation('system.exec', { cmd: 'ls' })).toEqual({ toolName: 'system.exec', expectSuccess: true });
    expect(captureExpectation('coder.test', {})).toEqual({ toolName: 'coder.test', expectSuccess: true });
    expect(captureExpectation('web.search', {})).toBeNull();
  });
});

describe('CW7 — mismatch lowers bias beyond the normal failure path', () => {
  it('CW7-3: mismatches drive the success-rate (and thus bias) strictly lower than the normal failure path alone', () => {
    const withAgency = freshStore();
    const withoutAgency = freshStore();
    const monitor = new AgencyMonitor(withAgency, new DoomLoopDetector());
    const exp = captureExpectation('coder.test', {});

    // Seed both identically with successes so the EMA sits in the UNCLAMPED band
    // (chronic-failure bias floors at MIN_BIAS by design; measure the raw signal).
    for (let i = 0; i < 6; i++) { withAgency.record('coder.test', true); withoutAgency.record('coder.test', true); }
    // Same two real failures on both; only the agency store adds the violation nudge.
    for (let i = 0; i < 2; i++) {
      withAgency.record('coder.test', false);
      withoutAgency.record('coder.test', false);
      monitor.onToolResult(exp, false);
    }
    const emaA = withAgency.successRate('coder.test')!;
    const emaB = withoutAgency.successRate('coder.test')!;
    expect(emaA).toBeLessThan(emaB);                          // strictly lower success rate
    expect(withAgency.bias('coder.test')).toBeLessThanOrEqual(withoutAgency.bias('coder.test')); // => bias no higher
    expect(monitor.totalMismatches()).toBe(2);
  });

  it('CW7-4: the per-mismatch penalty never exceeds one EMA step', () => {
    const store = freshStore();
    store.record('coder.edit-file', true); // seed n=1, ema=1
    const before = store.successRate('coder.edit-file')!;
    store.penalize('coder.edit-file'); // default factor 0.5
    const after = store.successRate('coder.edit-file')!;
    const drop = before - after;
    // One full EMA step toward 0 would be alpha*ema; the nudge (factor 0.5) is half that.
    expect(drop).toBeLessThanOrEqual(DEFAULT_ALPHA * before + 1e-9);
    expect(drop).toBeGreaterThan(0);
  });

  it('CW7-5: onToolResult is a no-op on success and on out-of-scope (null expectation)', () => {
    const store = freshStore();
    store.record('coder.test', true);
    const seed = store.successRate('coder.test')!;
    const monitor = new AgencyMonitor(store, new DoomLoopDetector());
    expect(monitor.onToolResult(captureExpectation('coder.test', {}), true)).toBe(false); // success
    expect(monitor.onToolResult(captureExpectation('web.fetch', {}), false)).toBe(false); // out of scope
    expect(store.successRate('coder.test')).toBe(seed); // untouched
    expect(monitor.totalMismatches()).toBe(0);
  });
});

describe('CW7 — doom-loop trips earlier with accrued mismatches', () => {
  const args = { cmd: 'flaky' };

  it('CW7-6: with mismatch weight, the warning fires in fewer literal repeats than without', () => {
    // Baseline: how many cross-turn repeats to reach the warn threshold, no agency.
    const plain = new DoomLoopDetector();
    let plainTurnsToWarn = 0;
    for (let turn = 1; turn <= 10; turn++) {
      const r = plain.recordCall('system.exec', args, turn);
      if (r.action === 'warn') { plainTurnsToWarn = turn; break; }
    }
    expect(plainTurnsToWarn).toBe(DOOM_LOOP_THRESHOLD); // 4 distinct turns

    // With agency: pre-accrue mismatches, then the same repeats warn sooner.
    const withAgency = new DoomLoopDetector();
    const monitor = new AgencyMonitor(freshStore(), withAgency);
    const exp = captureExpectation('system.exec', args);
    for (let i = 0; i < 2; i++) monitor.onToolResult(exp, false); // 2 accrued mismatches
    let agencyTurnsToWarn = 0;
    for (let turn = 1; turn <= 10; turn++) {
      const r = withAgency.recordCall('system.exec', args, turn);
      if (r.action === 'warn') { agencyTurnsToWarn = turn; break; }
    }
    expect(agencyTurnsToWarn).toBeGreaterThan(0);
    expect(agencyTurnsToWarn).toBeLessThan(plainTurnsToWarn); // earlier
  });

  it('CW7-7: mismatch weight alone can WARN but never ABORT without a real repeat', () => {
    const doom = new DoomLoopDetector();
    const monitor = new AgencyMonitor(freshStore(), doom);
    const exp = captureExpectation('coder.npm', {});
    for (let i = 0; i < 20; i++) monitor.onToolResult(exp, false); // saturate weight
    // First real call: effective = 1 + min(weight, RO-1). Capped so it can warn, not abort.
    const r = doom.recordCall('coder.npm', { pkg: 'x' }, 1);
    expect(r.action).not.toBe('abort');
    expect(monitor.totalMismatches()).toBe(20);
    expect(monitor.snapshot()[0]).toEqual({ tool: 'coder.npm', mismatches: 20 });
  });
});
