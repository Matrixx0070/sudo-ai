/**
 * @file stats.test.ts
 * @description Tests for the slice-7 telemetry reader + cascade ranker.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MODE_SIMILARITY,
  blendScores,
  blendSimilarity,
  collapseByMode,
  computeEmpiricalSimilarity,
  effectiveSimilarity,
  loadRecentStats,
  loadRecentStatsByMode,
  parseModeSimilarityEnv,
  pearson,
  pearsonLowerBound,
  rankCascade,
  spearman,
  spearmanLowerBound,
  weightedCollapseByMode,
  wilsonLowerBound,
  type ModelStats,
  type ModeSimilarityMatrix,
} from '../../../../src/core/tools/builtin/coder/arsenal-v2/stats.js';

let root: string;
let logPath: string;
const NOW = 1_800_000_000_000; // fixed clock for deterministic windowing

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arsenal-v2-stats-'));
  logPath = path.join(root, 'data', 'arsenal-v2-telemetry.jsonl');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const dayMs = 24 * 60 * 60 * 1000;

/** Drop a JSONL log file with the given rows. */
async function seed(rows: object[]): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(logPath, text, 'utf-8');
}

function row(over: Partial<{ ts: number; model: string; criticVerdict: string | null; success: boolean; durationMs: number }> = {}): object {
  return {
    ts: NOW - dayMs, // one day ago by default
    sessionId: 'sess',
    mode: 'fix',
    attemptIndex: 1,
    maxAttempts: 3,
    model: 'm-default',
    applied: 1,
    skipped: 0,
    failed: 0,
    tscClean: true,
    tscErrorCount: 0,
    testsPassed: true,
    criticVerdict: 'approve',
    success: true,
    durationMs: 1000,
    ...over,
  };
}

describe('loadRecentStats', () => {
  it('returns an empty map when the file does not exist', () => {
    const stats = loadRecentStats({ path: logPath, now: NOW });
    expect(stats.size).toBe(0);
  });

  it('aggregates verdict counts across multiple rows for the same model', async () => {
    await seed([
      row({ model: 'A', criticVerdict: 'approve', success: true }),
      row({ model: 'A', criticVerdict: 'approve', success: true }),
      row({ model: 'A', criticVerdict: 'needs_revision', success: false }),
      row({ model: 'A', criticVerdict: 'error', success: false }),
      row({ model: 'A', criticVerdict: null, success: false }),
    ]);
    const stats = loadRecentStats({ path: logPath, now: NOW });
    const a = stats.get('A')!;
    expect(a.attempts).toBe(5);
    expect(a.approvals).toBe(2);
    expect(a.rejections).toBe(1);
    expect(a.errors).toBe(2); // 'error' + null
    expect(a.successes).toBe(2);
  });

  it('filters rows outside the window', async () => {
    await seed([
      row({ model: 'A', ts: NOW - 1 * dayMs }), // inside default 7-day window
      row({ model: 'A', ts: NOW - 30 * dayMs }), // outside
      row({ model: 'A', ts: NOW - 10 * dayMs }), // outside
    ]);
    const stats = loadRecentStats({ path: logPath, now: NOW });
    expect(stats.get('A')!.attempts).toBe(1);
  });

  it('respects a custom windowMs', async () => {
    await seed([
      row({ model: 'A', ts: NOW - 2 * dayMs }),
      row({ model: 'A', ts: NOW - 4 * dayMs }),
    ]);
    const stats = loadRecentStats({ path: logPath, now: NOW, windowMs: 3 * dayMs });
    expect(stats.get('A')!.attempts).toBe(1);
  });

  it('skips malformed lines without throwing', async () => {
    const good = JSON.stringify(row({ model: 'A' }));
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, `${good}\n{not-json\n${good}\n\n   \n`, 'utf-8');
    const stats = loadRecentStats({ path: logPath, now: NOW });
    expect(stats.get('A')!.attempts).toBe(2);
  });

  it('skips rows missing required fields', async () => {
    await seed([
      row({ model: 'A' }),
      { ts: NOW, /* missing model */ criticVerdict: 'approve' } as object,
      { model: 'B', /* missing ts */ criticVerdict: 'approve' } as object,
    ]);
    const stats = loadRecentStats({ path: logPath, now: NOW });
    expect(stats.size).toBe(1);
    expect(stats.get('A')!.attempts).toBe(1);
  });

  it('computes avgDurationMs and lastSeen across rows', async () => {
    await seed([
      row({ model: 'A', ts: NOW - 5 * dayMs, durationMs: 1000 }),
      row({ model: 'A', ts: NOW - 2 * dayMs, durationMs: 3000 }),
      row({ model: 'A', ts: NOW - 1 * dayMs, durationMs: 5000 }),
    ]);
    const stats = loadRecentStats({ path: logPath, now: NOW });
    const a = stats.get('A')!;
    expect(a.avgDurationMs).toBe(3000);
    expect(a.lastSeen).toBe(NOW - 1 * dayMs);
  });

  it('handles two models independently', async () => {
    await seed([
      row({ model: 'A', criticVerdict: 'approve' }),
      row({ model: 'A', criticVerdict: 'approve' }),
      row({ model: 'B', criticVerdict: 'needs_revision' }),
      row({ model: 'B', criticVerdict: 'approve' }),
      row({ model: 'B', criticVerdict: 'approve' }),
    ]);
    const stats = loadRecentStats({ path: logPath, now: NOW });
    expect(stats.get('A')!.attempts).toBe(2);
    expect(stats.get('A')!.approvals).toBe(2);
    expect(stats.get('B')!.attempts).toBe(3);
    expect(stats.get('B')!.approvals).toBe(2);
  });
});

describe('rankCascade', () => {
  const mkStats = (m: string, attempts: number, approvals: number): ModelStats => ({
    model: m,
    attempts,
    approvals,
    rejections: 0,
    errors: 0,
    successes: approvals,
    avgDurationMs: 1000,
    lastSeen: NOW,
    // Slice 10: assume no decay in synthetic stats — equivalent to weights
    // of 1.0 per row. The slice-10 Wilson-on-weighted scoring then collapses
    // to plain Wilson on integer counts, preserving the slice-7 test
    // expectations under the new score function.
    weightedAttempts: attempts,
    weightedApprovals: approvals,
  });

  it('returns single-element cascade unchanged', () => {
    expect(rankCascade(['solo'], new Map())).toEqual(['solo']);
  });

  it('returns empty cascade unchanged', () => {
    expect(rankCascade([], new Map())).toEqual([]);
  });

  it('returns original order when no stats are available', () => {
    expect(rankCascade(['A', 'B', 'C'], new Map())).toEqual(['A', 'B', 'C']);
  });

  it('promotes a high-approval model above a low-approval one', () => {
    const stats = new Map<string, ModelStats>();
    stats.set('A', mkStats('A', 10, 2)); // 20%
    stats.set('B', mkStats('B', 10, 9)); // 90%
    expect(rankCascade(['A', 'B'], stats)).toEqual(['B', 'A']);
  });

  it('keeps original order for under-sampled (< minSamples) models', () => {
    const stats = new Map<string, ModelStats>();
    stats.set('A', mkStats('A', 1, 1)); // 100% but only 1 sample → unknown
    stats.set('B', mkStats('B', 2, 0)); // 0% but only 2 samples → unknown
    // Both treated as defaultScore (0.5); stable sort preserves original order.
    expect(rankCascade(['A', 'B'], stats)).toEqual(['A', 'B']);
  });

  it('mixes known + unknown models with stable tiebreak', () => {
    const stats = new Map<string, ModelStats>();
    stats.set('B', mkStats('B', 10, 9));  // 90% — known, will float to top
    stats.set('C', mkStats('C', 10, 1));  // 10% — known, will sink
    // A has no stats → unknown (0.5), keeps original position relative to other unknowns.
    expect(rankCascade(['A', 'B', 'C'], stats)).toEqual(['B', 'A', 'C']);
  });

  it('breaks ties by original cascade index (stability)', () => {
    const stats = new Map<string, ModelStats>();
    stats.set('A', mkStats('A', 10, 5));
    stats.set('B', mkStats('B', 10, 5));
    stats.set('C', mkStats('C', 10, 5));
    expect(rankCascade(['C', 'A', 'B'], stats)).toEqual(['C', 'A', 'B']);
  });

  it('respects a custom minSamples', () => {
    const stats = new Map<string, ModelStats>();
    stats.set('A', mkStats('A', 1, 1)); // 1 sample
    stats.set('B', mkStats('B', 1, 0));
    // With minSamples=1, A's 100% should win.
    expect(rankCascade(['B', 'A'], stats, { minSamples: 1 })).toEqual(['A', 'B']);
  });
});

describe('loadRecentStatsByMode', () => {
  it('returns an empty map when the file is missing', () => {
    const out = loadRecentStatsByMode({ path: logPath, now: NOW });
    expect(out.size).toBe(0);
  });

  it('buckets rows by mode and keeps model stats independent per mode', async () => {
    await seed([
      row({ mode: 'fix', model: 'A', criticVerdict: 'approve' }),
      row({ mode: 'fix', model: 'A', criticVerdict: 'approve' }),
      row({ mode: 'refactor', model: 'A', criticVerdict: 'needs_revision' }),
      row({ mode: 'refactor', model: 'A', criticVerdict: 'needs_revision' }),
    ]);
    const out = loadRecentStatsByMode({ path: logPath, now: NOW });
    expect(out.size).toBe(2);
    const fixA = out.get('fix')!.get('A')!;
    const refA = out.get('refactor')!.get('A')!;
    expect(fixA.attempts).toBe(2);
    expect(fixA.approvals).toBe(2);
    expect(refA.attempts).toBe(2);
    expect(refA.approvals).toBe(0);
    expect(refA.rejections).toBe(2);
  });

  it('skips rows missing the mode field', async () => {
    const good = JSON.stringify(row({ mode: 'fix', model: 'A' }));
    const noMode = JSON.stringify({ ...row({ model: 'A' }), mode: undefined });
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, `${good}\n${noMode}\n`, 'utf-8');
    const out = loadRecentStatsByMode({ path: logPath, now: NOW });
    expect(out.size).toBe(1);
    expect(out.get('fix')!.get('A')!.attempts).toBe(1);
  });

  it('respects the same windowing as loadRecentStats', async () => {
    await seed([
      row({ mode: 'fix', model: 'A', ts: NOW - 1 * dayMs }), // inside
      row({ mode: 'fix', model: 'A', ts: NOW - 30 * dayMs }), // outside
    ]);
    const out = loadRecentStatsByMode({ path: logPath, now: NOW });
    expect(out.get('fix')!.get('A')!.attempts).toBe(1);
  });

  it('computes avgDurationMs per (mode, model) bucket independently', async () => {
    await seed([
      row({ mode: 'fix', model: 'A', durationMs: 1000 }),
      row({ mode: 'fix', model: 'A', durationMs: 2000 }),
      row({ mode: 'refactor', model: 'A', durationMs: 10_000 }),
    ]);
    const out = loadRecentStatsByMode({ path: logPath, now: NOW });
    expect(out.get('fix')!.get('A')!.avgDurationMs).toBe(1500);
    expect(out.get('refactor')!.get('A')!.avgDurationMs).toBe(10_000);
  });
});

describe('wilsonLowerBound', () => {
  it('returns 0 when attempts is 0 or negative', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, -1)).toBe(0);
  });

  it('returns 0 for attempts = NaN', () => {
    expect(wilsonLowerBound(1, NaN)).toBe(0);
  });

  it('never returns negative — clamps at 0', () => {
    // For p=0 the formula can dip negative due to the margin; we clamp.
    expect(wilsonLowerBound(0, 100)).toBeGreaterThanOrEqual(0);
  });

  it('penalizes small samples heavily compared to large samples at the same ratio', () => {
    // 3/3 (100%) vs 100/100 (100%) — Wilson should give the larger sample
    // a meaningfully higher lower bound.
    const small = wilsonLowerBound(3, 3);
    const large = wilsonLowerBound(100, 100);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(0.95);
  });

  it('matches the textbook value at p=0.5, n=100, z=1.96 within tolerance', () => {
    // Wilson lower bound for 50/100 at z=1.96 is ~0.402.
    const v = wilsonLowerBound(50, 100, 1.96);
    expect(v).toBeGreaterThan(0.4);
    expect(v).toBeLessThan(0.41);
  });

  it('is monotonic in approvals (more approvals → higher bound) at fixed n', () => {
    const a = wilsonLowerBound(50, 100);
    const b = wilsonLowerBound(60, 100);
    const c = wilsonLowerBound(70, 100);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('tolerates non-integer (decay-weighted) inputs', () => {
    // 6.0 approvals / 8.5 attempts — realistic post-decay values.
    expect(() => wilsonLowerBound(6.0, 8.5)).not.toThrow();
    const v = wilsonLowerBound(6.0, 8.5);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });
});

describe('slice-10 decay weighting in loadRecentStats', () => {
  it('a row at age 0 has weight ~1, at one half-life has weight ~0.5', async () => {
    await seed([
      row({ model: 'A', ts: NOW, criticVerdict: 'approve' }),         // weight ~1
      row({ model: 'A', ts: NOW - 3 * dayMs, criticVerdict: 'approve' }), // weight ~0.5 at 3-day halfLife
    ]);
    const stats = loadRecentStats({ path: logPath, now: NOW, halfLifeMs: 3 * dayMs });
    const a = stats.get('A')!;
    expect(a.attempts).toBe(2); // raw count unchanged
    expect(a.approvals).toBe(2);
    expect(a.weightedAttempts).toBeGreaterThan(1.4);
    expect(a.weightedAttempts).toBeLessThan(1.6);
    expect(a.weightedApprovals).toBeCloseTo(a.weightedAttempts, 5);
  });

  it('halfLifeMs <= 0 disables decay (all weights = 1)', async () => {
    await seed([
      row({ model: 'A', ts: NOW - 6 * dayMs, criticVerdict: 'approve' }),
      row({ model: 'A', ts: NOW, criticVerdict: 'approve' }),
    ]);
    const stats = loadRecentStats({ path: logPath, now: NOW, halfLifeMs: 0 });
    const a = stats.get('A')!;
    expect(a.weightedAttempts).toBe(2);
    expect(a.weightedApprovals).toBe(2);
  });
});

describe('slice-10 Wilson + decay integration with rankCascade', () => {
  it('Wilson stops a tiny-sample 100% from outranking a large-sample 95%', async () => {
    // A: 3/3 approvals (100%). B: 95/100 approvals (95%). Plain ratio would
    // tie at A=1.0 > B=0.95. Wilson should pick B.
    await seed([
      ...Array.from({ length: 3 }, () => row({ mode: 'fix', model: 'A', ts: NOW, criticVerdict: 'approve' })),
      ...Array.from({ length: 95 }, () => row({ mode: 'fix', model: 'B', ts: NOW, criticVerdict: 'approve' })),
      ...Array.from({ length: 5 }, () => row({ mode: 'fix', model: 'B', ts: NOW, criticVerdict: 'needs_revision' })),
    ]);
    const byMode = loadRecentStatsByMode({ path: logPath, now: NOW, halfLifeMs: 0 });
    const ranked = rankCascade(['A', 'B'], byMode.get('fix')!);
    expect(ranked).toEqual(['B', 'A']);
  });

  it('decay lets a recent approval streak outrank an old rejection streak', async () => {
    // A: 10 rejections 6 days ago. B: 10 approvals 1 hour ago.
    await seed([
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'A', ts: NOW - 6 * dayMs, criticVerdict: 'needs_revision' })),
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'B', ts: NOW - 3600 * 1000, criticVerdict: 'approve' })),
    ]);
    const byMode = loadRecentStatsByMode({ path: logPath, now: NOW, halfLifeMs: 3 * dayMs });
    const ranked = rankCascade(['A', 'B'], byMode.get('fix')!);
    expect(ranked).toEqual(['B', 'A']);
  });
});

describe('rankCascade with per-mode stats (integration)', () => {
  it('mode-A stats do not leak into mode-B ranking', async () => {
    // A is great at fix, terrible at refactor. B is the opposite.
    await seed([
      // fix: A approved 10×, B rejected 10×
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'A', criticVerdict: 'approve' })),
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'B', criticVerdict: 'needs_revision' })),
      // refactor: B approved 10×, A rejected 10×
      ...Array.from({ length: 10 }, () => row({ mode: 'refactor', model: 'B', criticVerdict: 'approve' })),
      ...Array.from({ length: 10 }, () => row({ mode: 'refactor', model: 'A', criticVerdict: 'needs_revision' })),
    ]);
    const byMode = loadRecentStatsByMode({ path: logPath, now: NOW });

    const fixCascade = rankCascade(['B', 'A'], byMode.get('fix')!);
    const refCascade = rankCascade(['A', 'B'], byMode.get('refactor')!);

    expect(fixCascade).toEqual(['A', 'B']); // A wins for fix
    expect(refCascade).toEqual(['B', 'A']); // B wins for refactor
  });
});

describe('blendScores', () => {
  it('returns defaultScore when both inputs are null', () => {
    expect(blendScores(null, null, 0, 10, 0.5)).toBe(0.5);
  });
  it('returns globalScore when only it is present (no mode data)', () => {
    expect(blendScores(null, 0.8, 0, 10, 0.5)).toBe(0.8);
  });
  it('returns modeScore when only it is present (no global data)', () => {
    expect(blendScores(0.6, null, 5, 10, 0.5)).toBe(0.6);
  });
  it('weights 50/50 when modeAttempts === modeShrinkageK', () => {
    // m=10, k=10 → w_mode = 10/20 = 0.5; final = 0.5 * 0.9 + 0.5 * 0.5 = 0.7
    expect(blendScores(0.9, 0.5, 10, 10, 0)).toBeCloseTo(0.7, 5);
  });
  it('shifts toward mode as modeAttempts grow', () => {
    const low = blendScores(0.9, 0.5, 1, 10, 0);   // w ≈ 0.09 → ~0.54
    const mid = blendScores(0.9, 0.5, 10, 10, 0);  // w = 0.5 → 0.7
    const high = blendScores(0.9, 0.5, 90, 10, 0); // w = 0.9 → 0.86
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });
  it('pathological k=0 with no global falls back gracefully', () => {
    // denom = modeAttempts + 0; if modeAttempts > 0 the formula works (w=1, pure mode).
    expect(blendScores(0.8, 0.4, 5, 0, 0.5)).toBeCloseTo(0.8, 5);
    // denom = 0 + 0 = 0 → pathological — fall back to global.
    expect(blendScores(0.8, 0.4, 0, 0, 0.5)).toBe(0.4);
  });
});

describe('collapseByMode', () => {
  it('returns an empty map when input is empty', () => {
    expect(collapseByMode(new Map()).size).toBe(0);
  });

  it('preserves a single-mode map as-is (defensive copy)', () => {
    const inner = new Map<string, ModelStats>();
    const a: ModelStats = {
      model: 'A', attempts: 5, approvals: 3, rejections: 1, errors: 1, successes: 3,
      avgDurationMs: 1000, lastSeen: 100, weightedAttempts: 5, weightedApprovals: 3,
    };
    inner.set('A', a);
    const out = collapseByMode(new Map([['fix', inner]]));
    expect(out.get('A')).toEqual(a);
    // Defensive copy: mutating the result doesn't leak into the input.
    out.get('A')!.attempts = 999;
    expect(inner.get('A')!.attempts).toBe(5);
  });

  it('sums counts and weighted sums across modes for the same model', () => {
    const fix = new Map<string, ModelStats>();
    fix.set('A', {
      model: 'A', attempts: 3, approvals: 3, rejections: 0, errors: 0, successes: 3,
      avgDurationMs: 1000, lastSeen: 100, weightedAttempts: 2.5, weightedApprovals: 2.5,
    });
    const refactor = new Map<string, ModelStats>();
    refactor.set('A', {
      model: 'A', attempts: 7, approvals: 2, rejections: 4, errors: 1, successes: 2,
      avgDurationMs: 2000, lastSeen: 200, weightedAttempts: 5, weightedApprovals: 1.5,
    });
    const out = collapseByMode(new Map([['fix', fix], ['refactor', refactor]]));
    const a = out.get('A')!;
    expect(a.attempts).toBe(10);
    expect(a.approvals).toBe(5);
    expect(a.rejections).toBe(4);
    expect(a.errors).toBe(1);
    expect(a.successes).toBe(5);
    expect(a.weightedAttempts).toBeCloseTo(7.5, 5);
    expect(a.weightedApprovals).toBeCloseTo(4.0, 5);
    expect(a.lastSeen).toBe(200);
    // avgDurationMs is attempt-weighted: (3*1000 + 7*2000) / 10 = 1700
    expect(a.avgDurationMs).toBe(1700);
  });

  it('keeps separate model buckets independent', () => {
    const fix = new Map<string, ModelStats>();
    fix.set('A', {
      model: 'A', attempts: 5, approvals: 5, rejections: 0, errors: 0, successes: 5,
      avgDurationMs: 1000, lastSeen: 100, weightedAttempts: 5, weightedApprovals: 5,
    });
    fix.set('B', {
      model: 'B', attempts: 5, approvals: 0, rejections: 5, errors: 0, successes: 0,
      avgDurationMs: 2000, lastSeen: 200, weightedAttempts: 5, weightedApprovals: 0,
    });
    const out = collapseByMode(new Map([['fix', fix]]));
    expect(out.get('A')!.approvals).toBe(5);
    expect(out.get('B')!.approvals).toBe(0);
  });
});

describe('slice-11 cross-mode fallback in rankCascade', () => {
  it('a model with strong global but zero mode data is no longer treated as fully unknown', async () => {
    // A: 10 approvals in fix mode, 0 rows in refactor mode → mode is empty,
    // but global has 10 approvals.
    // B: 10 rejections in fix mode, 0 rows in refactor → global has 10 rejections.
    await seed([
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'A', criticVerdict: 'approve' })),
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'B', criticVerdict: 'needs_revision' })),
    ]);
    const byMode = loadRecentStatsByMode({ path: logPath, now: NOW, halfLifeMs: 0 });
    const refactorStats = byMode.get('refactor') ?? new Map<string, ModelStats>();
    const globalStats = collapseByMode(byMode);
    // Refactor stats are empty for both — without global, both are unknown
    // (defaultScore) and the declared order would be preserved.
    const declaredOrder = rankCascade(['B', 'A'], refactorStats);
    expect(declaredOrder).toEqual(['B', 'A']);
    // With global: A's strong fix-mode history bubbles up via the blend.
    const blended = rankCascade(['B', 'A'], refactorStats, { globalStats });
    expect(blended).toEqual(['A', 'B']);
  });

  it('strong in-mode signal still beats a weaker general signal (slice-9 isolation preserved)', async () => {
    // A is great at fix, terrible at refactor (10/10 vs 0/10).
    // B is the opposite. With cross-mode fallback enabled, mode signal
    // should still dominate when both models have enough mode samples.
    await seed([
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'A', criticVerdict: 'approve' })),
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'B', criticVerdict: 'needs_revision' })),
      ...Array.from({ length: 10 }, () => row({ mode: 'refactor', model: 'B', criticVerdict: 'approve' })),
      ...Array.from({ length: 10 }, () => row({ mode: 'refactor', model: 'A', criticVerdict: 'needs_revision' })),
    ]);
    const byMode = loadRecentStatsByMode({ path: logPath, now: NOW, halfLifeMs: 0 });
    const globalStats = collapseByMode(byMode);
    const fixCascade = rankCascade(['B', 'A'], byMode.get('fix')!, { globalStats });
    const refCascade = rankCascade(['A', 'B'], byMode.get('refactor')!, { globalStats });
    expect(fixCascade).toEqual(['A', 'B']);
    expect(refCascade).toEqual(['B', 'A']);
  });

  it('declared order is preserved when global is also empty', async () => {
    // No telemetry at all — no file, no rows. Cascade should be unchanged.
    const out = rankCascade(['A', 'B', 'C'], new Map(), { globalStats: new Map() });
    expect(out).toEqual(['A', 'B', 'C']);
  });
});

describe('parseModeSimilarityEnv', () => {
  it('returns null for missing / empty input', () => {
    expect(parseModeSimilarityEnv(undefined)).toBeNull();
    expect(parseModeSimilarityEnv('')).toBeNull();
    expect(parseModeSimilarityEnv('   ')).toBeNull();
  });
  it('returns null for malformed JSON', () => {
    expect(parseModeSimilarityEnv('{not json')).toBeNull();
    expect(parseModeSimilarityEnv('"a string"')).toBeNull();
    expect(parseModeSimilarityEnv('[]')).toBeNull();
  });
  it('parses a valid matrix', () => {
    const out = parseModeSimilarityEnv(JSON.stringify({ fix: { build: 0.8, test: 0.3 } }));
    expect(out).toEqual({ fix: { build: 0.8, test: 0.3 } });
  });
  it('caps weights above 1 to 1', () => {
    const out = parseModeSimilarityEnv(JSON.stringify({ fix: { build: 2.5 } }));
    expect(out).toEqual({ fix: { build: 1 } });
  });
  it('drops non-numeric / non-finite / non-positive weights', () => {
    const out = parseModeSimilarityEnv(
      JSON.stringify({ fix: { build: 0.5, bad: 'x', neg: -1, zero: 0, inf: Infinity } }),
    );
    expect(out).toEqual({ fix: { build: 0.5 } });
  });
  it('drops rows that have no valid weights after filtering', () => {
    const out = parseModeSimilarityEnv(JSON.stringify({ fix: { bad: 'x' }, build: { test: 0.3 } }));
    expect(out).toEqual({ build: { test: 0.3 } });
  });
  it('returns null when nothing valid remains', () => {
    expect(parseModeSimilarityEnv(JSON.stringify({ fix: { bad: 'x' } }))).toBeNull();
  });
});

describe('DEFAULT_MODE_SIMILARITY', () => {
  it('clusters code-writing modes with mutual weight ≥ 0.4', () => {
    for (const a of ['fix', 'build', 'refactor', 'test']) {
      for (const b of ['fix', 'build', 'refactor', 'test']) {
        if (a === b) continue;
        const w = DEFAULT_MODE_SIMILARITY[a]?.[b];
        expect(w, `${a}->${b}`).toBeGreaterThanOrEqual(0.4);
      }
    }
  });
  it('clusters read-only modes with mutual weight ≥ 0.5', () => {
    for (const a of ['review', 'analyze', 'explain']) {
      for (const b of ['review', 'analyze', 'explain']) {
        if (a === b) continue;
        const w = DEFAULT_MODE_SIMILARITY[a]?.[b];
        expect(w, `${a}->${b}`).toBeGreaterThanOrEqual(0.5);
      }
    }
  });
  it('cross-cluster weights are ≤ 0.3', () => {
    const writing = ['fix', 'build', 'refactor', 'test'];
    const reading = ['review', 'analyze', 'explain'];
    for (const a of writing) {
      for (const b of reading) {
        const w = DEFAULT_MODE_SIMILARITY[a]?.[b];
        expect(w, `${a}->${b}`).toBeLessThanOrEqual(0.3);
      }
    }
  });
});

describe('weightedCollapseByMode', () => {
  const mk = (m: string, attempts: number, approvals: number, lastSeen = 100): ModelStats => ({
    model: m,
    attempts,
    approvals,
    rejections: 0,
    errors: 0,
    successes: approvals,
    avgDurationMs: 1000,
    lastSeen,
    weightedAttempts: attempts,
    weightedApprovals: approvals,
  });

  it('returns empty when input is empty', () => {
    expect(weightedCollapseByMode(new Map(), 'fix').size).toBe(0);
  });

  it('falls back to flat collapseByMode when currentMode is missing from the matrix', () => {
    const byMode = new Map<string, Map<string, ModelStats>>();
    const fix = new Map([['A', mk('A', 5, 5)]]);
    byMode.set('fix', fix);
    // 'unknown-mode' isn't in the default matrix → should equal collapseByMode.
    const out = weightedCollapseByMode(byMode, 'unknown-mode');
    const flat = collapseByMode(byMode);
    expect(out.get('A')!.attempts).toBe(flat.get('A')!.attempts);
    expect(out.get('A')!.approvals).toBe(flat.get('A')!.approvals);
  });

  it('excludes the current mode from the weighted sum', () => {
    // A has 10 rows in 'fix' AND 10 rows in 'refactor'. For currentMode='fix',
    // only the refactor rows should contribute (weighted by sim(fix, refactor) = 0.7).
    const byMode = new Map<string, Map<string, ModelStats>>();
    byMode.set('fix', new Map([['A', mk('A', 10, 10)]]));
    byMode.set('refactor', new Map([['A', mk('A', 10, 8)]]));
    const out = weightedCollapseByMode(byMode, 'fix');
    expect(out.get('A')!.attempts).toBeCloseTo(7, 5); // 10 * 0.7
    expect(out.get('A')!.approvals).toBeCloseTo(5.6, 5); // 8 * 0.7
  });

  it('weights other modes by similarity, dropping unweighted modes', () => {
    const matrix: ModeSimilarityMatrix = { fix: { build: 0.6, refactor: 0.8 } };
    const byMode = new Map<string, Map<string, ModelStats>>();
    byMode.set('build', new Map([['A', mk('A', 10, 10)]]));
    byMode.set('refactor', new Map([['A', mk('A', 5, 5)]]));
    byMode.set('explain', new Map([['A', mk('A', 100, 100)]])); // dropped (no entry)
    const out = weightedCollapseByMode(byMode, 'fix', matrix);
    // 10*0.6 + 5*0.8 = 6 + 4 = 10
    expect(out.get('A')!.attempts).toBeCloseTo(10, 5);
    // 10*0.6 + 5*0.8 = 10
    expect(out.get('A')!.approvals).toBeCloseTo(10, 5);
  });

  it('produces fractional counts (Wilson handles them downstream)', () => {
    const matrix: ModeSimilarityMatrix = { fix: { build: 0.3 } };
    const byMode = new Map<string, Map<string, ModelStats>>();
    byMode.set('build', new Map([['A', mk('A', 7, 5)]]));
    const out = weightedCollapseByMode(byMode, 'fix', matrix);
    expect(out.get('A')!.attempts).toBeCloseTo(2.1, 5);
    expect(out.get('A')!.approvals).toBeCloseTo(1.5, 5);
  });

  it('keeps lastSeen as the max across contributing modes', () => {
    const matrix: ModeSimilarityMatrix = { fix: { build: 0.5, refactor: 0.5 } };
    const byMode = new Map<string, Map<string, ModelStats>>();
    byMode.set('build', new Map([['A', mk('A', 5, 5, 100)]]));
    byMode.set('refactor', new Map([['A', mk('A', 5, 5, 200)]]));
    const out = weightedCollapseByMode(byMode, 'fix', matrix);
    expect(out.get('A')!.lastSeen).toBe(200);
  });
});

describe('slice-12 mode-similarity integration', () => {
  it('a model with strong fix-mode history lifts more in build (sim 0.6) than in explain (sim 0.1)', async () => {
    // Two models, both with NO build/explain data, both with fix-mode signal.
    // A: 10/10 in fix. B: 10/0 in fix. Cascade ranking should depend on the
    // current mode's similarity to fix.
    await seed([
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'A', criticVerdict: 'approve' })),
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'B', criticVerdict: 'needs_revision' })),
    ]);
    const byMode = loadRecentStatsByMode({ path: logPath, now: NOW, halfLifeMs: 0 });

    // For build: sim(build, fix) = 0.6 — A's 10/10 contributes 6/6, B's 10/0 → 6/0.
    // wilson(6, 6) > wilson(0, 6) → A should rank first.
    const buildGlobal = weightedCollapseByMode(byMode, 'build');
    const buildCascade = rankCascade(['B', 'A'], new Map(), { globalStats: buildGlobal });
    expect(buildCascade).toEqual(['A', 'B']);

    // For explain: sim(explain, fix) = 0.1 — A's 10/10 contributes 1/1.
    // Total attempts = 1 → below minSamples=3 → both treated as unknown →
    // declared order ['B','A'] preserved.
    const explainGlobal = weightedCollapseByMode(byMode, 'explain');
    const explainCascade = rankCascade(['B', 'A'], new Map(), { globalStats: explainGlobal });
    expect(explainCascade).toEqual(['B', 'A']);
  });

  it('current mode is NOT double-counted via the weighted collapse', async () => {
    // A has 10/10 only in fix mode. Ranking for fix should use the mode
    // signal directly; the weighted global excludes fix (the current mode).
    // With no other modes contributing, weighted global is empty → A's
    // total attempts = 10 (from modeStats only), Wilson lower bound on
    // 10/10 wins handily.
    await seed([
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'A', criticVerdict: 'approve' })),
      ...Array.from({ length: 10 }, () => row({ mode: 'fix', model: 'B', criticVerdict: 'needs_revision' })),
    ]);
    const byMode = loadRecentStatsByMode({ path: logPath, now: NOW, halfLifeMs: 0 });
    const fixGlobal = weightedCollapseByMode(byMode, 'fix');
    // fixGlobal should be empty — no other modes contributing.
    expect(fixGlobal.size).toBe(0);
    const fixCascade = rankCascade(['B', 'A'], byMode.get('fix')!, { globalStats: fixGlobal });
    expect(fixCascade).toEqual(['A', 'B']);
  });
});

describe('pearson', () => {
  it('returns 0 for n < 2', () => {
    expect(pearson([], [])).toBe(0);
    expect(pearson([1], [1])).toBe(0);
  });
  it('returns 0 for mismatched lengths', () => {
    expect(pearson([1, 2], [1])).toBe(0);
  });
  it('returns 1 for perfectly correlated vectors', () => {
    expect(pearson([0, 0.25, 0.5, 0.75, 1], [0, 0.25, 0.5, 0.75, 1])).toBeCloseTo(1, 5);
  });
  it('returns -1 for perfectly anti-correlated vectors', () => {
    expect(pearson([1, 0.75, 0.5, 0.25, 0], [0, 0.25, 0.5, 0.75, 1])).toBeCloseTo(-1, 5);
  });
  it('returns 0 when either vector has zero variance', () => {
    expect(pearson([0.5, 0.5, 0.5], [0.1, 0.2, 0.9])).toBe(0);
    expect(pearson([0.1, 0.2, 0.9], [0.5, 0.5, 0.5])).toBe(0);
  });
  it('handles a moderate correlation within tolerance', () => {
    // Two vectors that should land somewhere between 0 and 1.
    const r = pearson([0.9, 0.8, 0.5, 0.3], [0.85, 0.7, 0.6, 0.4]);
    expect(r).toBeGreaterThan(0.8);
    expect(r).toBeLessThan(1);
  });
});

describe('computeEmpiricalSimilarity', () => {
  const mkS = (m: string, attempts: number, approvals: number): ModelStats => ({
    model: m,
    attempts,
    approvals,
    rejections: 0,
    errors: 0,
    successes: approvals,
    avgDurationMs: 1000,
    lastSeen: 100,
    weightedAttempts: attempts,
    weightedApprovals: approvals,
  });

  it('returns an empty matrix when there are fewer than 2 shared models', () => {
    const byMode = new Map<string, Map<string, ModelStats>>();
    byMode.set('fix', new Map([['A', mkS('A', 5, 5)]]));
    byMode.set('build', new Map([['A', mkS('A', 5, 5)]])); // only 1 shared
    const { matrix, sharedCounts } = computeEmpiricalSimilarity(byMode);
    expect(matrix.fix?.build).toBeUndefined();
    expect(sharedCounts.get('fix')!.get('build')).toBe(1);
  });

  it('produces a high lower-bound correlation when fix-rates and build-rates agree across enough models', () => {
    // Slice 14: Fisher CI requires n >= 4 shared models. Use 5 for a
    // comfortable margin; the lower bound is in (0.5, 1] at n = 5 with
    // strongly-correlated rates.
    const byMode = new Map<string, Map<string, ModelStats>>();
    byMode.set('fix', new Map([
      ['A', mkS('A', 10, 9)],
      ['B', mkS('B', 10, 7)],
      ['C', mkS('C', 10, 5)],
      ['D', mkS('D', 10, 3)],
      ['E', mkS('E', 10, 1)],
    ]));
    byMode.set('build', new Map([
      ['A', mkS('A', 10, 8)],
      ['B', mkS('B', 10, 7)],
      ['C', mkS('C', 10, 5)],
      ['D', mkS('D', 10, 4)],
      ['E', mkS('E', 10, 2)],
    ]));
    const { matrix } = computeEmpiricalSimilarity(byMode);
    // Raw Pearson here is ~0.99; Fisher lower bound at n=5, z=1 lands ~0.85.
    expect(matrix.fix?.build).toBeGreaterThan(0.5);
    expect(matrix.fix?.build).toBeLessThanOrEqual(1);
  });

  it('returns no entry when shared models < 4 (Fisher CI undefined)', () => {
    // Slice 14: 3 shared models — Fisher SE requires n > 3, so the
    // entry is omitted. This is the corrected behavior; slice 13 would
    // have produced a high empirical correlation here.
    const byMode = new Map<string, Map<string, ModelStats>>();
    byMode.set('fix', new Map([
      ['A', mkS('A', 10, 9)],
      ['B', mkS('B', 10, 5)],
      ['C', mkS('C', 10, 1)],
    ]));
    byMode.set('build', new Map([
      ['A', mkS('A', 10, 8)],
      ['B', mkS('B', 10, 6)],
      ['C', mkS('C', 10, 2)],
    ]));
    const { matrix, sharedCounts } = computeEmpiricalSimilarity(byMode);
    expect(matrix.fix?.build).toBeUndefined();
    // sharedCounts still records the count — the blend uses it for confidence.
    expect(sharedCounts.get('fix')!.get('build')).toBe(3);
  });

  it('clamps negative correlations to 0 (omits from the result row)', () => {
    const byMode = new Map<string, Map<string, ModelStats>>();
    // Anti-correlated: A great at fix bad at build; B opposite; C middle; D, E to clear the n >= 4 gate.
    byMode.set('fix', new Map([
      ['A', mkS('A', 10, 9)],
      ['B', mkS('B', 10, 1)],
      ['C', mkS('C', 10, 5)],
      ['D', mkS('D', 10, 8)],
      ['E', mkS('E', 10, 2)],
    ]));
    byMode.set('build', new Map([
      ['A', mkS('A', 10, 1)],
      ['B', mkS('B', 10, 9)],
      ['C', mkS('C', 10, 5)],
      ['D', mkS('D', 10, 2)],
      ['E', mkS('E', 10, 8)],
    ]));
    const { matrix } = computeEmpiricalSimilarity(byMode);
    expect(matrix.fix?.build).toBeUndefined();
  });

  it('excludes models with too few samples (per-mode minPerModelSamples)', () => {
    const byMode = new Map<string, Map<string, ModelStats>>();
    byMode.set('fix', new Map([
      ['A', mkS('A', 2, 2)], // below default minPerModelSamples=3
      ['B', mkS('B', 10, 5)],
    ]));
    byMode.set('build', new Map([
      ['A', mkS('A', 10, 5)],
      ['B', mkS('B', 10, 5)],
    ]));
    const { sharedCounts } = computeEmpiricalSimilarity(byMode);
    expect(sharedCounts.get('fix')!.get('build')).toBe(1); // only B qualifies
  });

  it('respects a custom minPerModelSamples', () => {
    const byMode = new Map<string, Map<string, ModelStats>>();
    byMode.set('fix', new Map([
      ['A', mkS('A', 1, 1)],
      ['B', mkS('B', 1, 0)],
    ]));
    byMode.set('build', new Map([
      ['A', mkS('A', 1, 1)],
      ['B', mkS('B', 1, 0)],
    ]));
    const { sharedCounts } = computeEmpiricalSimilarity(byMode, { minPerModelSamples: 1 });
    expect(sharedCounts.get('fix')!.get('build')).toBe(2);
  });
});

describe('blendSimilarity', () => {
  it('returns the default unchanged when sharedCounts are all 0', () => {
    const defaults: ModeSimilarityMatrix = { fix: { build: 0.6 } };
    const empirical: ModeSimilarityMatrix = { fix: { build: 0.95 } };
    const shared = new Map<string, Map<string, number>>();
    shared.set('fix', new Map([['build', 0]]));
    const out = blendSimilarity(empirical, defaults, shared);
    expect(out.fix!.build).toBeCloseTo(0.6, 5);
  });

  it('weights 50/50 when shared count equals the shrinkage constant', () => {
    const defaults: ModeSimilarityMatrix = { fix: { build: 0.6 } };
    const empirical: ModeSimilarityMatrix = { fix: { build: 1.0 } };
    const shared = new Map<string, Map<string, number>>();
    shared.set('fix', new Map([['build', 5]])); // = default k=5 → 50/50
    const out = blendSimilarity(empirical, defaults, shared);
    expect(out.fix!.build).toBeCloseTo(0.8, 5); // 0.5*1.0 + 0.5*0.6 = 0.8
  });

  it('shifts toward empirical as shared count grows', () => {
    const defaults: ModeSimilarityMatrix = { fix: { build: 0.6 } };
    const empirical: ModeSimilarityMatrix = { fix: { build: 1.0 } };
    const mk = (shared: number) => {
      const s = new Map<string, Map<string, number>>();
      s.set('fix', new Map([['build', shared]]));
      return blendSimilarity(empirical, defaults, s).fix!.build;
    };
    expect(mk(1)).toBeLessThan(mk(5));
    expect(mk(5)).toBeLessThan(mk(50));
    expect(mk(500)).toBeGreaterThan(0.99); // far past k=5 → ~empirical
  });

  it('includes pairs present only in defaults at full default weight', () => {
    const defaults: ModeSimilarityMatrix = { fix: { build: 0.6, refactor: 0.7 } };
    const empirical: ModeSimilarityMatrix = { fix: { build: 0.95 } }; // no refactor
    const shared = new Map<string, Map<string, number>>();
    shared.set('fix', new Map([['build', 10]]));
    const out = blendSimilarity(empirical, defaults, shared);
    expect(out.fix!.refactor).toBeCloseTo(0.7, 5); // unchanged
  });

  it('respects a custom shrinkageK', () => {
    const defaults: ModeSimilarityMatrix = { fix: { build: 0.6 } };
    const empirical: ModeSimilarityMatrix = { fix: { build: 1.0 } };
    const shared = new Map<string, Map<string, number>>();
    shared.set('fix', new Map([['build', 5]]));
    const out = blendSimilarity(empirical, defaults, shared, { shrinkageK: 50 });
    // w_data = 5 / (5 + 50) = 0.091 → ~0.91*0.6 + 0.09*1.0 = 0.636
    expect(out.fix!.build).toBeCloseTo(0.636, 2);
  });
});

describe('effectiveSimilarity', () => {
  it('falls through to defaults when byMode is empty', () => {
    const out = effectiveSimilarity(new Map(), DEFAULT_MODE_SIMILARITY);
    expect(out.fix!.build).toBeCloseTo(DEFAULT_MODE_SIMILARITY.fix!.build!, 5);
  });

  it('promotes the empirical signal when enough shared models accumulate', async () => {
    const dayMsLocal = 24 * 60 * 60 * 1000;
    // Seed 6 shared models in fix and build, all with strongly-correlated
    // rates → empirical Pearson ≈ 1.0, blend ≈ 0.5 * 1 + 0.5 * 0.6 = 0.8.
    const rates = [0.9, 0.85, 0.7, 0.5, 0.3, 0.1];
    const rows: object[] = [];
    rates.forEach((p, i) => {
      const model = `M${i}`;
      for (let j = 0; j < 10; j++) {
        rows.push(row({ mode: 'fix', model, ts: NOW - dayMsLocal, criticVerdict: j / 10 < p ? 'approve' : 'needs_revision' }));
        rows.push(row({ mode: 'build', model, ts: NOW - dayMsLocal, criticVerdict: j / 10 < p ? 'approve' : 'needs_revision' }));
      }
    });
    await seed(rows);
    const byMode = loadRecentStatsByMode({ path: logPath, now: NOW, halfLifeMs: 0 });
    const sim = effectiveSimilarity(byMode, DEFAULT_MODE_SIMILARITY);
    // Empirical correlation should be high; blend lifts it above the default 0.6.
    expect(sim.fix!.build).toBeGreaterThan(DEFAULT_MODE_SIMILARITY.fix!.build!);
  });

  it('drops below the default when the empirical signal disagrees with enough shared models', async () => {
    const dayMsLocal = 24 * 60 * 60 * 1000;
    // Anti-correlated: high rate in fix → low rate in build for each model.
    // Empirical → 0 (clamped); blend pulls fix-build below the default 0.6.
    const fixRates = [0.9, 0.85, 0.7, 0.5, 0.3, 0.1];
    const buildRates = [0.1, 0.15, 0.3, 0.5, 0.7, 0.9];
    const rows: object[] = [];
    fixRates.forEach((p, i) => {
      const model = `M${i}`;
      for (let j = 0; j < 10; j++) {
        rows.push(row({ mode: 'fix', model, ts: NOW - dayMsLocal, criticVerdict: j / 10 < p ? 'approve' : 'needs_revision' }));
        rows.push(row({ mode: 'build', model, ts: NOW - dayMsLocal, criticVerdict: j / 10 < buildRates[i]! ? 'approve' : 'needs_revision' }));
      }
    });
    await seed(rows);
    const byMode = loadRecentStatsByMode({ path: logPath, now: NOW, halfLifeMs: 0 });
    const sim = effectiveSimilarity(byMode, DEFAULT_MODE_SIMILARITY);
    expect(sim.fix!.build).toBeLessThan(DEFAULT_MODE_SIMILARITY.fix!.build!);
  });
});

describe('pearsonLowerBound (slice 14)', () => {
  it('returns 0 when either vector has fewer than 4 points', () => {
    expect(pearsonLowerBound([], [])).toBe(0);
    expect(pearsonLowerBound([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('returns 0 when the point estimate is non-positive', () => {
    // Perfect anti-correlation → raw Pearson = -1 → clamped to 0.
    const xs = [1, 2, 3, 4, 5];
    const ys = [5, 4, 3, 2, 1];
    expect(pearsonLowerBound(xs, ys)).toBe(0);
  });

  it('returns 1 when the point estimate is exactly 1', () => {
    const xs = [0.1, 0.3, 0.5, 0.7, 0.9];
    expect(pearsonLowerBound(xs, xs)).toBe(1);
  });

  it('applies a large haircut at small n', () => {
    // r = 0.9 at n=5 → lower bound ~0.64 (z=1.0).
    // Build vectors so Pearson lands close to 0.9.
    const xs = [0.9, 0.7, 0.5, 0.3, 0.1];
    const ys = [0.85, 0.75, 0.5, 0.25, 0.15];
    const raw = pearson(xs, ys);
    const lower = pearsonLowerBound(xs, ys);
    expect(raw).toBeGreaterThan(0.9);
    expect(lower).toBeLessThan(raw);
    expect(lower).toBeGreaterThan(0.5);
  });

  it('applies a small haircut at large n', () => {
    // 100 highly-correlated samples → lower bound very close to raw r.
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 100; i++) {
      const v = i / 99;
      xs.push(v);
      ys.push(v * 0.9 + (i % 2 === 0 ? 0.05 : -0.05));
    }
    const raw = pearson(xs, ys);
    const lower = pearsonLowerBound(xs, ys);
    expect(raw - lower).toBeLessThan(0.05);
  });

  it('is monotone non-decreasing in n at fixed r', () => {
    // Same correlation, growing n → tighter CI → higher lower bound.
    const makePair = (n: number): { xs: number[]; ys: number[] } => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < n; i++) {
        xs.push(i % 2 === 0 ? 0.9 : 0.1);
        ys.push(i % 2 === 0 ? 0.85 : 0.15);
      }
      return { xs, ys };
    };
    const lo4 = pearsonLowerBound(makePair(4).xs, makePair(4).ys);
    const lo20 = pearsonLowerBound(makePair(20).xs, makePair(20).ys);
    const lo100 = pearsonLowerBound(makePair(100).xs, makePair(100).ys);
    expect(lo4).toBeLessThan(lo20);
    expect(lo20).toBeLessThan(lo100);
  });

  it('respects the z parameter (larger z = wider CI = lower bound)', () => {
    const xs = [0.9, 0.7, 0.5, 0.3, 0.1];
    const ys = [0.85, 0.75, 0.5, 0.25, 0.15];
    const lo1 = pearsonLowerBound(xs, ys, 1.0); // ~84% CI
    const lo196 = pearsonLowerBound(xs, ys, 1.96); // 95% CI
    expect(lo196).toBeLessThan(lo1);
  });
});

describe('spearman (slice 15)', () => {
  it('returns 0 for length < 2 or length mismatch', () => {
    expect(spearman([], [])).toBe(0);
    expect(spearman([1], [1])).toBe(0);
    expect(spearman([1, 2], [1])).toBe(0);
  });

  it('returns 1 for a perfectly monotonic relationship even when non-linear', () => {
    // y = exp(x): non-linear but strictly monotonic. Pearson < 1; Spearman = 1.
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => Math.exp(x));
    const p = pearson(xs, ys);
    const s = spearman(xs, ys);
    expect(p).toBeLessThan(0.99);
    expect(s).toBeCloseTo(1, 5);
  });

  it('returns -1 for a perfectly monotonic-decreasing relationship', () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => -Math.exp(x));
    expect(spearman(xs, ys)).toBeCloseTo(-1, 5);
  });

  it('handles tied values with average ranks', () => {
    // [3, 5, 5, 7] → ranks [1, 2.5, 2.5, 4]
    const xs = [3, 5, 5, 7];
    const ys = [10, 20, 20, 30];
    expect(spearman(xs, ys)).toBeCloseTo(1, 5);
  });

  it('returns 0 when either vector has zero variance', () => {
    expect(spearman([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
    expect(spearman([1, 2, 3, 4], [5, 5, 5, 5])).toBe(0);
  });
});

describe('spearmanLowerBound (slice 15)', () => {
  it('returns 0 for n < 4', () => {
    expect(spearmanLowerBound([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('returns 1 for a perfectly monotonic relationship', () => {
    const xs = [0.1, 0.2, 0.3, 0.4, 0.5];
    const ys = xs.map((x) => Math.exp(x));
    expect(spearmanLowerBound(xs, ys)).toBe(1);
  });

  it('beats pearsonLowerBound on a monotonic non-linear relationship', () => {
    // y = x^3: strictly monotonic, but Pearson on raw values is < 1.
    const xs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    const ys = xs.map((x) => x ** 3);
    const p = pearsonLowerBound(xs, ys);
    const s = spearmanLowerBound(xs, ys);
    expect(s).toBeGreaterThan(p);
  });

  it('applies the same Fisher haircut shape as pearsonLowerBound', () => {
    // On a strictly linear relationship, Pearson = Spearman = 1 (both
    // produce 1.0 from the perfect-correlation early return).
    const xs = [1, 2, 3, 4, 5];
    const ys = [2, 4, 6, 8, 10];
    expect(pearsonLowerBound(xs, ys)).toBe(1);
    expect(spearmanLowerBound(xs, ys)).toBe(1);
  });
});

describe('computeEmpiricalSimilarity — method dispatch (slice 15)', () => {
  const mkS = (m: string, attempts: number, approvals: number): ModelStats => ({
    model: m,
    attempts,
    approvals,
    rejections: 0,
    errors: 0,
    successes: approvals,
    avgDurationMs: 1000,
    lastSeen: 100,
    weightedAttempts: attempts,
    weightedApprovals: approvals,
  });

  it('default method is pearson (slice-14 behavior preserved)', () => {
    const byMode = new Map<string, Map<string, ModelStats>>();
    byMode.set('fix', new Map([
      ['A', mkS('A', 10, 9)],
      ['B', mkS('B', 10, 7)],
      ['C', mkS('C', 10, 5)],
      ['D', mkS('D', 10, 3)],
      ['E', mkS('E', 10, 1)],
    ]));
    byMode.set('build', new Map([
      ['A', mkS('A', 10, 8)],
      ['B', mkS('B', 10, 7)],
      ['C', mkS('C', 10, 5)],
      ['D', mkS('D', 10, 4)],
      ['E', mkS('E', 10, 2)],
    ]));
    const noOpt = computeEmpiricalSimilarity(byMode);
    const pearsonOpt = computeEmpiricalSimilarity(byMode, { method: 'pearson' });
    expect(noOpt.matrix.fix?.build).toBeCloseTo(pearsonOpt.matrix.fix?.build ?? 0, 5);
  });

  it('spearman picks up monotonic non-linear correlation where pearson is weaker', () => {
    // Rates rank-correlated but with a non-linear shape — Spearman should
    // produce a higher correlation than Pearson.
    const byMode = new Map<string, Map<string, ModelStats>>();
    const ratesFix = [0.95, 0.7, 0.5, 0.3, 0.05];
    // Build rates: roughly the same ranks but with a different curve.
    const ratesBuild = [0.99, 0.6, 0.55, 0.15, 0.01];
    const models = ['A', 'B', 'C', 'D', 'E'];
    const fixMap = new Map<string, ModelStats>();
    const buildMap = new Map<string, ModelStats>();
    models.forEach((m, i) => {
      const approvalsFix = Math.round(ratesFix[i]! * 100);
      const approvalsBuild = Math.round(ratesBuild[i]! * 100);
      fixMap.set(m, mkS(m, 100, approvalsFix));
      buildMap.set(m, mkS(m, 100, approvalsBuild));
    });
    byMode.set('fix', fixMap);
    byMode.set('build', buildMap);

    const pearsonR = computeEmpiricalSimilarity(byMode, { method: 'pearson' }).matrix.fix!.build!;
    const spearmanR = computeEmpiricalSimilarity(byMode, { method: 'spearman' }).matrix.fix!.build!;
    // Both should detect a positive correlation; Spearman should equal or
    // exceed Pearson since the relationship is strictly rank-correlated.
    expect(spearmanR).toBeGreaterThanOrEqual(pearsonR);
  });
});
