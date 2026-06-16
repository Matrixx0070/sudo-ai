/**
 * @file stats.test.ts
 * @description Tests for the slice-7 telemetry reader + cascade ranker.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadRecentStats,
  loadRecentStatsByMode,
  rankCascade,
  wilsonLowerBound,
  type ModelStats,
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
