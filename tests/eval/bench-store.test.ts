/**
 * Tests for bench-store.ts — Wave 10 Builder 2.
 *
 * Covers:
 *   - BenchResult insert + retrieve
 *   - Filter by runId, model, condition
 *   - BenchReport upsert + retrieve
 *   - listReports returns recent runs
 */

import { describe, it, expect } from 'vitest';
import { BenchStore } from '../../src/core/eval/bench-store.js';
import type { BenchResult, BenchReport } from '../../src/core/shared/wave10-types.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-store-'));
  return path.join(dir, 'bench.db');
}

function makeResult(overrides: Partial<BenchResult> = {}): BenchResult {
  return {
    id:             randomUUID(),
    runId:          randomUUID(),
    model:          'grok',
    agentId:        'default',
    taskId:         'task-hello',
    condition:      'no_skills',
    seedIndex:      0,
    success:        true,
    latencyMs:      42,
    costUsd:        0.001,
    complexityTier: 'simple',
    timestamp:      new Date().toISOString(),
    ...overrides,
  };
}

function makeReport(overrides: Partial<BenchReport> = {}): BenchReport {
  return {
    runId:           randomUUID(),
    startedAt:       new Date().toISOString(),
    completedAt:     new Date().toISOString(),
    totalTasks:      5,
    successRate:     0.8,
    medianLatencyMs: 100,
    p99LatencyMs:    500,
    totalCostUsd:    0.05,
    byCondition: {
      no_skills:        { successRate: 0.8, medianLatencyMs: 100 },
      skills_on:        { successRate: 0.8, medianLatencyMs: 100 },
      skills_optimized: { successRate: 0.8, medianLatencyMs: 100 },
    },
    byModel: {
      grok: { successRate: 0.8, medianLatencyMs: 100 },
    },
    markdownSummary: '## Test Report',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BenchResult CRUD
// ---------------------------------------------------------------------------

describe('BenchStore — BenchResult CRUD', () => {
  it('inserts and retrieves a single result by runId', () => {
    const store  = new BenchStore(makeTempDb());
    const result = makeResult();
    store.insertResult(result);

    const rows = store.listResults({ runId: result.runId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(result.id);
    expect(rows[0]!.success).toBe(true);
    expect(rows[0]!.latencyMs).toBe(42);
    store.close();
  });

  it('inserts multiple results in a batch', () => {
    const store   = new BenchStore(makeTempDb());
    const runId   = randomUUID();
    const results = Array.from({ length: 5 }, () => makeResult({ runId }));
    store.insertResults(results);

    const rows = store.listResults({ runId });
    expect(rows).toHaveLength(5);
    store.close();
  });

  it('filters results by model', () => {
    const store = new BenchStore(makeTempDb());
    const r1 = makeResult({ model: 'grok' });
    const r2 = makeResult({ model: 'claude' });
    store.insertResults([r1, r2]);

    const rows = store.listResults({ model: 'grok' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe('grok');
    store.close();
  });

  it('filters results by condition', () => {
    const store = new BenchStore(makeTempDb());
    const r1 = makeResult({ condition: 'no_skills' });
    const r2 = makeResult({ condition: 'skills_on' });
    store.insertResults([r1, r2]);

    const noSkillsRows = store.listResults({ condition: 'no_skills' });
    expect(noSkillsRows).toHaveLength(1);
    expect(noSkillsRows[0]!.condition).toBe('no_skills');
    store.close();
  });

  it('respects limit parameter', () => {
    const store   = new BenchStore(makeTempDb());
    const results = Array.from({ length: 10 }, () => makeResult());
    store.insertResults(results);

    const rows = store.listResults({ limit: 3 });
    expect(rows).toHaveLength(3);
    store.close();
  });

  it('throws on id collision', () => {
    const store  = new BenchStore(makeTempDb());
    const result = makeResult();
    store.insertResult(result);
    expect(() => store.insertResult(result)).toThrow();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// BenchReport CRUD
// ---------------------------------------------------------------------------

describe('BenchStore — BenchReport CRUD', () => {
  it('upserts and retrieves a report by runId', () => {
    const store  = new BenchStore(makeTempDb());
    const report = makeReport();
    store.upsertReport(report);

    const retrieved = store.getReport(report.runId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.runId).toBe(report.runId);
    expect(retrieved!.successRate).toBeCloseTo(0.8, 3);
    expect(retrieved!.totalTasks).toBe(5);
    store.close();
  });

  it('getReport returns null for unknown runId', () => {
    const store = new BenchStore(makeTempDb());
    expect(store.getReport('nonexistent')).toBeNull();
    store.close();
  });

  it('upsert replaces existing report', () => {
    const store  = new BenchStore(makeTempDb());
    const report = makeReport({ successRate: 0.8 });
    store.upsertReport(report);

    const updated = { ...report, successRate: 0.95 };
    store.upsertReport(updated);

    const retrieved = store.getReport(report.runId);
    expect(retrieved!.successRate).toBeCloseTo(0.95, 3);
    store.close();
  });

  it('listReports returns recent summaries newest-first', () => {
    const store = new BenchStore(makeTempDb());
    const r1 = makeReport({ startedAt: '2026-01-01T00:00:00Z' });
    const r2 = makeReport({ startedAt: '2026-01-02T00:00:00Z' });
    store.upsertReport(r1);
    store.upsertReport(r2);

    const list = store.listReports(10);
    expect(list.length).toBe(2);
    expect(list[0]!.startedAt).toBe('2026-01-02T00:00:00Z');
    store.close();
  });

  it('listReports respects limit', () => {
    const store = new BenchStore(makeTempDb());
    for (let i = 0; i < 5; i++) {
      store.upsertReport(makeReport({ startedAt: `2026-01-0${i + 1}T00:00:00Z` }));
    }
    const list = store.listReports(2);
    expect(list.length).toBe(2);
    store.close();
  });

  it('preserves byCondition JSON roundtrip', () => {
    const store  = new BenchStore(makeTempDb());
    const report = makeReport();
    store.upsertReport(report);

    const r = store.getReport(report.runId);
    expect(r!.byCondition['no_skills']?.successRate).toBeCloseTo(0.8, 3);
    expect(r!.byCondition['skills_on']?.successRate).toBeCloseTo(0.8, 3);
    store.close();
  });
});
