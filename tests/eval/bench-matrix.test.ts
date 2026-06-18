/**
 * Tests for bench-matrix — strategy-impact comparison.
 *
 * Pure layer (buildStrategyMatrix / renderStrategyMatrixMarkdown) is tested with
 * synthetic BenchResult runs. The live layer (runStrategyMatrix) is tested with a
 * fake StrategyBrain + a real BenchStore on a temp file + injected tasks — no LLM.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildStrategyMatrix,
  renderStrategyMatrixMarkdown,
  runStrategyMatrix,
  type StrategyRun,
  type StrategyBrain,
} from '../../src/core/eval/bench-matrix.js';
import { BenchStore } from '../../src/core/eval/bench-store.js';
import type { BenchResult, BenchTask } from '../../src/core/shared/wave10-types.js';

let seq = 0;
function res(taskId: string, success: boolean, opts: Partial<BenchResult> = {}): BenchResult {
  return {
    id: `r-${seq++}`,
    runId: 'run',
    model: 'm',
    agentId: 'a',
    taskId,
    condition: 'no_skills',
    seedIndex: 0,
    success,
    latencyMs: 1000,
    costUsd: 0,
    complexityTier: 'simple',
    timestamp: '2026-06-18T00:00:00.000Z',
    score: success ? 1 : 0,
    ...opts,
  };
}

function run(strategy: string, tasks: Array<[string, boolean]>, totalCostUsd?: number, latencyMs = 1000): StrategyRun {
  return {
    strategy,
    results: tasks.map(([t, s]) => res(t, s, { latencyMs })),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
  };
}

// ---------------------------------------------------------------------------
// buildStrategyMatrix
// ---------------------------------------------------------------------------

describe('buildStrategyMatrix', () => {
  it('defaults the baseline to single and puts it first', () => {
    const m = buildStrategyMatrix([
      run('debate', [['t1', true], ['t2', true]]),
      run('single', [['t1', true], ['t2', false]]),
    ]);
    expect(m.baselineStrategy).toBe('single');
    expect(m.cells[0].strategy).toBe('single');
  });

  it('falls back to the first strategy when single is absent', () => {
    const m = buildStrategyMatrix([
      run('debate', [['t1', true]]),
      run('tree-search', [['t1', true]]),
    ]);
    expect(m.baselineStrategy).toBe('debate');
  });

  it('computes pass-rate / mean-score / cost / latency deltas vs baseline', () => {
    const m = buildStrategyMatrix([
      run('single', [['t1', true], ['t2', false]], 0.10, 1000), // passRate 0.5
      run('debate', [['t1', true], ['t2', true]], 0.30, 3000),  // passRate 1.0
    ]);
    const d = m.deltas.find(x => x.strategy === 'debate')!;
    expect(d.passRateDelta).toBeCloseTo(0.5, 10);
    expect(d.meanScoreDelta).toBeCloseTo(0.5, 10);
    expect(d.costRatio).toBeCloseTo(3, 10);     // $0.30 / $0.10
    expect(d.latencyRatio).toBeCloseTo(3, 10);  // 6000ms / 2000ms
  });

  it('overrides row cost with the explicit total and recomputes passesPerDollar', () => {
    const m = buildStrategyMatrix([
      run('single', [['t1', true], ['t2', true]], 0.50), // 2 passed / $0.50 = 4
    ]);
    const cell = m.cells[0].summary;
    expect(cell.totalCostUsd).toBeCloseTo(0.50, 10);
    expect(cell.passesPerDollar).toBeCloseTo(4, 10);
  });

  it('reports null cost/latency ratio when the baseline is zero', () => {
    const m = buildStrategyMatrix([
      run('single', [['t1', true]], 0, 0),
      run('debate', [['t1', true]], 0.10, 1000),
    ]);
    const d = m.deltas.find(x => x.strategy === 'debate')!;
    expect(d.costRatio).toBeNull();
    expect(d.latencyRatio).toBeNull();
  });

  it('throws when given no runs', () => {
    expect(() => buildStrategyMatrix([])).toThrow(/at least one/);
  });
});

// ---------------------------------------------------------------------------
// winner selection
// ---------------------------------------------------------------------------

describe('buildStrategyMatrix — winner', () => {
  it('picks the higher pass-rate strategy even if pricier', () => {
    const m = buildStrategyMatrix([
      run('single', [['t1', true], ['t2', false]], 0.10),
      run('debate', [['t1', true], ['t2', true]], 0.30),
    ]);
    expect(m.winner).toBe('debate');
  });

  it('breaks a pass-rate tie by lower cost', () => {
    const m = buildStrategyMatrix([
      run('single', [['t1', true]], 0.10),
      run('debate', [['t1', true]], 0.30), // same quality, 3× cost → single wins
    ]);
    expect(m.winner).toBe('single');
  });
});

// ---------------------------------------------------------------------------
// renderStrategyMatrixMarkdown
// ---------------------------------------------------------------------------

describe('renderStrategyMatrixMarkdown', () => {
  it('renders the matrix table, baseline tag, winner trophy and a Δ table', () => {
    const m = buildStrategyMatrix([
      run('single', [['t1', true], ['t2', false]], 0.10),
      run('debate', [['t1', true], ['t2', true]], 0.30),
    ]);
    const md = renderStrategyMatrixMarkdown(m);
    expect(md).toContain('## Strategy Matrix — baseline `single`');
    expect(md).toContain('_(baseline)_');
    expect(md).toContain('🏆');
    expect(md).toContain('Δ vs baseline');
    expect(md).toContain('Cost ×');
    expect(md).toContain('Winner: `debate`');
    expect(md).toContain('3.00×');
  });

  it('is deterministic for identical inputs', () => {
    const runs: StrategyRun[] = [
      run('single', [['t1', true]], 0.10),
      run('debate', [['t1', false]], 0.30),
    ];
    expect(renderStrategyMatrixMarkdown(buildStrategyMatrix(runs)))
      .toBe(renderStrategyMatrixMarkdown(buildStrategyMatrix(runs)));
  });
});

// ---------------------------------------------------------------------------
// runStrategyMatrix (live layer, fake brain + real store)
// ---------------------------------------------------------------------------

describe('runStrategyMatrix', () => {
  let dir: string;
  let store: BenchStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-matrix-'));
    store = new BenchStore(path.join(dir, 'bench.db'));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function task(id: string): BenchTask {
    return {
      id,
      name: id,
      prompt: `solve ${id}`,
      expectedOutput: 'CORRECT',
      complexityTier: 'simple',
      verifier: {
        type: 'string',
        async verify(_t, response) {
          const passed = response.includes('CORRECT');
          return { passed, score: passed ? 1 : 0, detail: passed ? 'ok' : 'wrong', type: 'string' };
        },
      },
    };
  }

  it('applies each strategy to the brain and surfaces the better one as winner', async () => {
    const seen: string[] = [];
    // 'debate' answers correctly (and costs more); 'single' is wrong.
    const brain: StrategyBrain = {
      async call(_req, opts) {
        const strategy = opts?.strategy ?? 'single';
        seen.push(strategy);
        const correct = strategy === 'debate';
        return {
          content: correct ? 'the answer is CORRECT' : 'no idea',
          usage: { estimatedCost: correct ? 0.03 : 0.01 },
        };
      },
    };

    const matrix = await runStrategyMatrix({
      brain,
      strategies: ['single', 'debate'],
      models: ['m'],
      store,
      tasks: [task('t1'), task('t2')],
      conditions: ['no_skills'],
      seeds: 1,
    });

    // Brain was invoked with both strategies (2 tasks each).
    expect(seen.filter(s => s === 'single')).toHaveLength(2);
    expect(seen.filter(s => s === 'debate')).toHaveLength(2);

    const single = matrix.cells.find(c => c.strategy === 'single')!;
    const debate = matrix.cells.find(c => c.strategy === 'debate')!;
    expect(single.summary.passRate).toBe(0);
    expect(debate.summary.passRate).toBe(1);
    // Cost was accumulated from brain.usage: 2 calls × $0.03.
    expect(debate.summary.totalCostUsd).toBeCloseTo(0.06, 10);
    expect(matrix.winner).toBe('debate');
    expect(matrix.deltas.find(d => d.strategy === 'debate')!.costRatio).toBeCloseTo(3, 10);
  });

  it('throws when no strategies are given', async () => {
    await expect(runStrategyMatrix({ brain: { call: async () => ({ content: '' }) }, strategies: [], models: ['m'], store }))
      .rejects.toThrow(/at least one/);
  });
});
