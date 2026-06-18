/**
 * Tests for bench-regression — the deterministic eval gate engine.
 *
 * Pure functions only: no I/O, no LLM, no clock. Each test pins one behaviour of
 * summarizeRun / compareRuns / renderRegressionMarkdown.
 */

import { describe, it, expect } from 'vitest';
import {
  summarizeRun,
  compareRuns,
  renderRegressionMarkdown,
  type RunSummary,
} from '../../src/core/eval/bench-regression.js';
import type { BenchResult } from '../../src/core/shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
function result(partial: Partial<BenchResult> & { taskId: string; success: boolean }): BenchResult {
  return {
    id: `r-${seq++}`,
    runId: 'run',
    model: 'm',
    agentId: 'a',
    condition: 'no_skills',
    seedIndex: 0,
    latencyMs: 1000,
    costUsd: 0.01,
    complexityTier: 'simple',
    timestamp: '2026-06-18T00:00:00.000Z',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// summarizeRun
// ---------------------------------------------------------------------------

describe('summarizeRun', () => {
  it('rolls per-seed rows up into per-task summaries and derived metrics', () => {
    const s = summarizeRun('run-1', [
      result({ taskId: 't1', success: true, costUsd: 0.02, latencyMs: 30_000 }),
      result({ taskId: 't2', success: false, costUsd: 0.04, latencyMs: 30_000 }),
    ]);

    expect(s.total).toBe(2);
    expect(s.passed).toBe(1);
    expect(s.passRate).toBe(0.5);
    expect(s.totalCostUsd).toBeCloseTo(0.06, 10);
    expect(s.totalLatencyMs).toBe(60_000); // 1 minute total
    // 1 passed task / $0.06
    expect(s.passesPerDollar).toBeCloseTo(1 / 0.06, 6);
    // 1 passed task / 1 minute
    expect(s.passesPerMinute).toBeCloseTo(1, 6);
  });

  it('treats a task as passed when ANY seed succeeds', () => {
    const s = summarizeRun('run-1', [
      result({ taskId: 't1', success: false }),
      result({ taskId: 't1', success: true }),
    ]);
    expect(s.total).toBe(1);
    expect(s.tasks[0].passed).toBe(true);
    expect(s.tasks[0].seedCount).toBe(2);
  });

  it('uses verifier score when present and falls back to success otherwise', () => {
    const s = summarizeRun('run-1', [
      result({ taskId: 't1', success: true, score: 0.5 }),
      result({ taskId: 't2', success: true }), // no score → 1.0
    ]);
    expect(s.tasks.find(t => t.taskId === 't1')!.score).toBeCloseTo(0.5, 10);
    expect(s.tasks.find(t => t.taskId === 't2')!.score).toBe(1);
  });

  it('clamps out-of-range scores into [0,1]', () => {
    const s = summarizeRun('run-1', [
      result({ taskId: 't1', success: true, score: 2.5 }),
      result({ taskId: 't2', success: true, score: -1 }),
    ]);
    expect(s.tasks.find(t => t.taskId === 't1')!.score).toBe(1);
    expect(s.tasks.find(t => t.taskId === 't2')!.score).toBe(0);
  });

  it('avoids Infinity when cost or latency is zero', () => {
    const s = summarizeRun('run-1', [
      result({ taskId: 't1', success: true, costUsd: 0, latencyMs: 0 }),
    ]);
    expect(s.passesPerDollar).toBe(0);
    expect(s.passesPerMinute).toBe(0);
  });

  it('returns zeroed metrics for an empty run', () => {
    const s = summarizeRun('run-1', []);
    expect(s.total).toBe(0);
    expect(s.passRate).toBe(0);
    expect(s.meanScore).toBe(0);
  });

  it('sorts tasks by id for stable output', () => {
    const s = summarizeRun('run-1', [
      result({ taskId: 'c', success: true }),
      result({ taskId: 'a', success: true }),
      result({ taskId: 'b', success: true }),
    ]);
    expect(s.tasks.map(t => t.taskId)).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// compareRuns
// ---------------------------------------------------------------------------

function run(label: string, tasks: Array<[string, boolean]>, opts?: { cost?: number; latency?: number }): RunSummary {
  return summarizeRun(
    label,
    tasks.map(([taskId, success]) =>
      result({ taskId, success, costUsd: opts?.cost ?? 0.01, latencyMs: opts?.latency ?? 1000 }),
    ),
    label,
  );
}

describe('compareRuns', () => {
  it('flags a pass→fail flip as a regression', () => {
    const base = run('base', [['t1', true], ['t2', true]]);
    const cur = run('cur', [['t1', true], ['t2', false]]);
    const v = compareRuns(base, cur);

    expect(v.isRegression).toBe(true);
    expect(v.regressedTasks).toEqual(['t2']);
    expect(v.reasons.some(r => r.includes('t2'))).toBe(true);
  });

  it('records a fail→pass flip as fixed without failing the gate', () => {
    const base = run('base', [['t1', false]]);
    const cur = run('cur', [['t1', true]]);
    const v = compareRuns(base, cur);

    expect(v.fixedTasks).toEqual(['t1']);
    expect(v.regressedTasks).toEqual([]);
    expect(v.isRegression).toBe(false);
    expect(v.passRateDelta).toBeCloseTo(1, 10);
  });

  it('passes when nothing changed', () => {
    const base = run('base', [['t1', true], ['t2', false]]);
    const cur = run('cur', [['t1', true], ['t2', false]]);
    const v = compareRuns(base, cur);
    expect(v.isRegression).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it('labels added and removed tasks distinctly', () => {
    const base = run('base', [['t1', true]]);
    const cur = run('cur', [['t1', true], ['t2', true]]);
    const v = compareRuns(base, cur);

    const added = v.taskDeltas.find(d => d.taskId === 't2');
    expect(added!.flip).toBe('added');
    expect(added!.baselinePassed).toBeNull();

    const back = compareRuns(cur, base);
    expect(back.taskDeltas.find(d => d.taskId === 't2')!.flip).toBe('removed');
  });

  it('honours maxPassRateDrop tolerance', () => {
    // 1/4 drop in pass-rate (one of four tasks regresses)
    const base = run('base', [['t1', true], ['t2', true], ['t3', true], ['t4', true]]);
    const cur = run('cur', [['t1', true], ['t2', true], ['t3', true], ['t4', false]]);

    // Default: any drop AND any task regression fails.
    expect(compareRuns(base, cur).isRegression).toBe(true);

    // Tolerate the 25-pt drop, but the task-flip rule still fires.
    const tolerated = compareRuns(base, cur, { maxPassRateDrop: 0.5, failOnAnyTaskRegression: false });
    expect(tolerated.isRegression).toBe(false);
  });

  it('gates on cost only when a threshold is supplied', () => {
    const base = run('base', [['t1', true]], { cost: 0.01 });
    const cur = run('cur', [['t1', true]], { cost: 0.02 }); // +100%

    expect(compareRuns(base, cur).isRegression).toBe(false); // cost not gated by default
    expect(v(cur, base).costDeltaPct).toBeCloseTo(-0.5, 10);

    const gated = compareRuns(base, cur, { maxCostIncreasePct: 0.5 });
    expect(gated.isRegression).toBe(true);
    expect(gated.reasons.some(r => r.toLowerCase().includes('cost'))).toBe(true);

    function v(a: RunSummary, b: RunSummary) { return compareRuns(a, b); }
  });

  it('gates on latency only when a threshold is supplied', () => {
    const base = run('base', [['t1', true]], { latency: 1000 });
    const cur = run('cur', [['t1', true]], { latency: 3000 }); // +200%

    expect(compareRuns(base, cur).isRegression).toBe(false);
    const gated = compareRuns(base, cur, { maxLatencyIncreasePct: 1.0 });
    expect(gated.isRegression).toBe(true);
    expect(gated.reasons.some(r => r.toLowerCase().includes('latency'))).toBe(true);
  });

  it('reports null cost/latency delta when baseline is zero', () => {
    const base = run('base', [['t1', true]], { cost: 0, latency: 0 });
    const cur = run('cur', [['t1', true]], { cost: 0.01, latency: 1000 });
    const gated = compareRuns(base, cur, { maxCostIncreasePct: 0, maxLatencyIncreasePct: 0 });
    expect(gated.costDeltaPct).toBeNull();
    expect(gated.latencyDeltaPct).toBeNull();
    // Null deltas can't trip the threshold (no baseline to compare against).
    expect(gated.isRegression).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderRegressionMarkdown
// ---------------------------------------------------------------------------

describe('renderRegressionMarkdown', () => {
  it('renders a PASS header and metric table when clean', () => {
    const base = run('base', [['t1', true]]);
    const cur = run('cur', [['t1', true]]);
    const md = renderRegressionMarkdown(compareRuns(base, cur));

    expect(md).toContain('🟢 PASS');
    expect(md).toContain('| Pass rate |');
    expect(md).toContain('| Passes / $ |');
    expect(md).toContain('| Passes / min |');
    expect(md).not.toContain('Why this failed');
  });

  it('renders a REGRESSION header with reasons and a regressed-tasks section', () => {
    const base = run('base', [['t1', true], ['t2', true]]);
    const cur = run('cur', [['t1', true], ['t2', false]]);
    const md = renderRegressionMarkdown(compareRuns(base, cur));

    expect(md).toContain('🔴 REGRESSION');
    expect(md).toContain('### Why this failed');
    expect(md).toContain('### ❌ Regressed (pass → fail)');
    expect(md).toContain('`t2`');
  });

  it('lists fixed, added and removed tasks', () => {
    const base = run('base', [['t1', false], ['gone', true]]);
    const cur = run('cur', [['t1', true], ['new', true]]);
    const md = renderRegressionMarkdown(compareRuns(base, cur));

    expect(md).toContain('### ✅ Fixed (fail → pass)');
    expect(md).toContain('`t1`');
    expect(md).toContain('New tasks');
    expect(md).toContain('`new`');
    expect(md).toContain('Removed tasks');
    expect(md).toContain('`gone`');
  });

  it('shows n/a for cost delta when baseline cost is zero', () => {
    const base = run('base', [['t1', true]], { cost: 0 });
    const cur = run('cur', [['t1', true]], { cost: 0.01 });
    const md = renderRegressionMarkdown(compareRuns(base, cur));
    expect(md).toContain('n/a');
  });

  it('is deterministic — identical inputs yield identical output', () => {
    const base = run('base', [['t1', true], ['t2', false]]);
    const cur = run('cur', [['t1', false], ['t2', true]]);
    const a = renderRegressionMarkdown(compareRuns(base, cur));
    const b = renderRegressionMarkdown(compareRuns(base, cur));
    expect(a).toBe(b);
  });
});
