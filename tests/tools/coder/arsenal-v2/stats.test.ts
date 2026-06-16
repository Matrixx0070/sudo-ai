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
  rankCascade,
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
