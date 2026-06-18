/**
 * End-to-end test for the Phase 1 verifier wiring inside BenchRunner.
 *
 * Verifies:
 *   - BenchRunner.runOne records the new per-result fields (score, verifierType, strategy,
 *     wallTimeMs, transcriptHash) on every row.
 *   - When a task carries a verifier, its verdict overrides the legacy non-empty check.
 *   - When a task has no verifier, the legacy non-empty check still applies.
 *   - BenchStore round-trips the new columns.
 */

import { describe, it, expect, vi } from 'vitest';
import { BenchRunner, type BrainCallable } from '../../src/core/eval/bench-runner.js';
import { BenchStore } from '../../src/core/eval/bench-store.js';
import { StringVerifier } from '../../src/core/eval/verifiers/string-verifier.js';
import type { BenchTask } from '../../src/core/shared/wave10-types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-integration-'));
  return path.join(dir, 'bench.db');
}

const verifiedTask: BenchTask = {
  id: 'verified',
  name: 'Verified task',
  prompt: 'Say hello.',
  expectedOutput: 'greeting',
  complexityTier: 'simple',
  verifier: new StringVerifier({ rules: [/\bhello\b/i] }),
};

const legacyTask: BenchTask = {
  id: 'legacy',
  name: 'Legacy task',
  prompt: 'Say something.',
  expectedOutput: 'anything non-empty',
  complexityTier: 'simple',
  // no verifier
};

function brainReturning(content: string): BrainCallable {
  return { call: vi.fn().mockResolvedValue({ content }) };
}

describe('BenchRunner — Phase 1 verifier wiring', () => {
  it('verifier-attached task uses verifier verdict (passes when response contains "hello")', async () => {
    const store = new BenchStore(makeTempDb());
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models: ['m'],
      conditions: ['no_skills'],
      seeds: 1,
      brain: brainReturning('hello there'),
      store,
      tasks: [verifiedTask],
      strategy: 'debate',
    });

    expect(report.totalTasks).toBe(1);
    expect(report.successRate).toBe(1);

    const rows = store.listResults({ runId: report.runId });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.success).toBe(true);
    expect(row.score).toBe(1);
    expect(row.verifierType).toBe('string');
    expect(row.verifierDetail).toContain('matched');
    expect(row.strategy).toBe('debate');
    expect(typeof row.wallTimeMs).toBe('number');
    expect(row.transcriptHash).toMatch(/^[0-9a-f]{64}$/);
    store.close();
  });

  it('verifier-attached task fails when response does not match', async () => {
    const store = new BenchStore(makeTempDb());
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models: ['m'],
      conditions: ['no_skills'],
      seeds: 1,
      brain: brainReturning('goodbye'),
      store,
      tasks: [verifiedTask],
    });

    expect(report.successRate).toBe(0);
    const rows = store.listResults({ runId: report.runId });
    expect(rows[0]!.score).toBe(0);
    expect(rows[0]!.verifierType).toBe('string');
    store.close();
  });

  it('verifier-less task uses legacy non-empty-response check', async () => {
    const store = new BenchStore(makeTempDb());
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models: ['m'],
      conditions: ['no_skills'],
      seeds: 1,
      brain: brainReturning('anything goes'),
      store,
      tasks: [legacyTask],
    });

    expect(report.successRate).toBe(1);
    const rows = store.listResults({ runId: report.runId });
    expect(rows[0]!.verifierType).toBe('legacy');
    store.close();
  });

  it('records strategy = "single" by default', async () => {
    const store = new BenchStore(makeTempDb());
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models: ['m'],
      conditions: ['no_skills'],
      seeds: 1,
      brain: brainReturning('hello'),
      store,
      tasks: [verifiedTask],
    });

    const rows = store.listResults({ runId: report.runId });
    expect(rows[0]!.strategy).toBe('single');
  });
});
