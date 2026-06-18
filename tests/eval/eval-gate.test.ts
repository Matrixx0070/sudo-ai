/**
 * Tests for eval-gate — the CI-gate orchestration layer over bench-regression.
 *
 * Covers baseline load/save round-trips (real temp files), input normalisation,
 * env threshold parsing, and the gate decision / exit-code logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadBaseline,
  saveBaseline,
  runGate,
  agentResultsToBenchResults,
  parseGateThresholdsFromEnv,
  summarizeRun,
  type AgentResultLike,
} from '../../src/core/eval/eval-gate.js';
import type { BenchResult } from '../../src/core/shared/wave10-types.js';

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

function summary(label: string, tasks: Array<[string, boolean]>) {
  return summarizeRun(label, tasks.map(([taskId, success]) => result({ taskId, success })), label);
}

// ---------------------------------------------------------------------------
// Baseline persistence
// ---------------------------------------------------------------------------

describe('loadBaseline / saveBaseline', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-gate-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a RunSummary through disk', () => {
    const s = summary('base', [['t1', true], ['t2', false]]);
    const file = path.join(dir, 'nested', 'baseline.json');
    saveBaseline(file, s, '2026-06-18T00:00:00.000Z');

    const loaded = loadBaseline(file);
    expect(loaded).not.toBeNull();
    expect(loaded!.passRate).toBeCloseTo(0.5, 10);
    expect(loaded!.tasks.map(t => t.taskId)).toEqual(['t1', 't2']);
  });

  it('writes a versioned, timestamped envelope', () => {
    const file = path.join(dir, 'baseline.json');
    saveBaseline(file, summary('base', [['t1', true]]), '2026-06-18T12:00:00.000Z');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.savedAt).toBe('2026-06-18T12:00:00.000Z');
    expect(parsed.summary.runId).toBe('base');
  });

  it('returns null for a missing file', () => {
    expect(loadBaseline(path.join(dir, 'does-not-exist.json'))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{not json');
    expect(loadBaseline(file)).toBeNull();
  });

  it('returns null when the envelope lacks a valid summary', () => {
    const file = path.join(dir, 'empty.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, savedAt: 'x' }));
    expect(loadBaseline(file)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// agentResultsToBenchResults
// ---------------------------------------------------------------------------

describe('agentResultsToBenchResults', () => {
  it('maps agent outputs to BenchResult rows with sane defaults', () => {
    const agent: AgentResultLike[] = [
      { taskId: 'divide-bug', passed: true, score: 1, model: 'claude-opus-4-8', wallTimeMs: 5000, transcriptHash: 'abcdef1234' },
      { taskId: 'js-bug-fix', passed: false },
    ];
    const rows = agentResultsToBenchResults(agent, 'run-x');
    expect(rows).toHaveLength(2);
    expect(rows[0].success).toBe(true);
    expect(rows[0].latencyMs).toBe(5000);
    expect(rows[0].costUsd).toBe(0); // agent runner has no cost yet
    expect(rows[0].id).toContain('divide-bug');
    expect(rows[1].score).toBe(0); // falls back from passed=false
    expect(rows[1].model).toBe('unknown');
  });

  it('feeds straight into summarizeRun', () => {
    const rows = agentResultsToBenchResults(
      [{ taskId: 't1', passed: true }, { taskId: 't2', passed: false }],
      'run-x',
    );
    const s = summarizeRun('run-x', rows);
    expect(s.total).toBe(2);
    expect(s.passed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseGateThresholdsFromEnv
// ---------------------------------------------------------------------------

describe('parseGateThresholdsFromEnv', () => {
  it('parses numeric thresholds and ignores blanks/garbage', () => {
    const t = parseGateThresholdsFromEnv({
      EVAL_GATE_MAX_PASS_RATE_DROP: '0.05',
      EVAL_GATE_MAX_COST_INCREASE_PCT: '0.2',
      EVAL_GATE_MAX_LATENCY_INCREASE_PCT: '',
      OTHER: 'ignored',
    });
    expect(t.maxPassRateDrop).toBeCloseTo(0.05, 10);
    expect(t.maxCostIncreasePct).toBeCloseTo(0.2, 10);
    expect(t.maxLatencyIncreasePct).toBeUndefined();
  });

  it('disables the task-flip rule only on explicit 0/false', () => {
    expect(parseGateThresholdsFromEnv({ EVAL_GATE_FAIL_ON_TASK_REGRESSION: '0' }).failOnAnyTaskRegression).toBe(false);
    expect(parseGateThresholdsFromEnv({ EVAL_GATE_FAIL_ON_TASK_REGRESSION: 'false' }).failOnAnyTaskRegression).toBe(false);
    expect(parseGateThresholdsFromEnv({ EVAL_GATE_FAIL_ON_TASK_REGRESSION: '1' }).failOnAnyTaskRegression).toBeUndefined();
    expect(parseGateThresholdsFromEnv({}).failOnAnyTaskRegression).toBeUndefined();
  });

  it('rejects non-finite numbers', () => {
    const t = parseGateThresholdsFromEnv({ EVAL_GATE_MAX_PASS_RATE_DROP: 'abc' });
    expect(t.maxPassRateDrop).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runGate
// ---------------------------------------------------------------------------

describe('runGate', () => {
  it('passes with a NO BASELINE notice when baseline is null', () => {
    const out = runGate({ baseline: null, current: summary('cur', [['t1', true]]) });
    expect(out.baselineMissing).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.verdict).toBeNull();
    expect(out.markdown).toContain('NO BASELINE');
  });

  it('exits 1 and renders a regression report on a pass→fail flip', () => {
    const out = runGate({
      baseline: summary('base', [['t1', true]]),
      current: summary('cur', [['t1', false]]),
    });
    expect(out.exitCode).toBe(1);
    expect(out.verdict!.isRegression).toBe(true);
    expect(out.markdown).toContain('🔴 REGRESSION');
  });

  it('exits 0 when the run is clean', () => {
    const out = runGate({
      baseline: summary('base', [['t1', true]]),
      current: summary('cur', [['t1', true]]),
    });
    expect(out.exitCode).toBe(0);
    expect(out.markdown).toContain('🟢 PASS');
  });

  it('honours thresholds passed through', () => {
    const base = summary('base', [['t1', true], ['t2', true]]);
    const cur = summary('cur', [['t1', true], ['t2', false]]);
    // Disable the flip rule AND tolerate the drop → no regression.
    const out = runGate({ baseline: base, current: cur, thresholds: { maxPassRateDrop: 1, failOnAnyTaskRegression: false } });
    expect(out.exitCode).toBe(0);
  });
});
