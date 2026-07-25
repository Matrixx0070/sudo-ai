/**
 * Tests for the AL7.4 judge-independence gate (CLAUDE.md invariant 7): the
 * comparator/judge route must be distinct from the route under test, and a
 * violation HOLDS the gate rather than passing or failing on merit.
 */

import { describe, it, expect } from 'vitest';
import {
  checkJudgeIndependence,
  resolveJudgeRoute,
  runGate,
  summarizeRun,
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

describe('checkJudgeIndependence', () => {
  it('passes when judge and candidate are distinct routes', () => {
    const r = checkJudgeIndependence({
      judgeRoute: 'claude-oauth/claude-fable-5',
      candidateRoute: 'xai-oauth/grok-4.5',
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('fails when the judge IS the route under test', () => {
    const r = checkJudgeIndependence({
      judgeRoute: 'xai-oauth/grok-4.5',
      candidateRoute: 'xai-oauth/grok-4.5',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('route under test');
  });

  it('compares case-insensitively with surrounding whitespace', () => {
    const r = checkJudgeIndependence({
      judgeRoute: '  XAI-OAuth/Grok-4.5 ',
      candidateRoute: 'xai-oauth/grok-4.5',
    });
    expect(r.ok).toBe(false);
  });

  it('fails when either route is undeclared — independence must be provable', () => {
    expect(checkJudgeIndependence({ judgeRoute: '', candidateRoute: 'x' }).ok).toBe(false);
    expect(checkJudgeIndependence({ judgeRoute: 'x', candidateRoute: '  ' }).ok).toBe(false);
  });
});

describe('resolveJudgeRoute', () => {
  it('picks the first route that is not the candidate', () => {
    expect(
      resolveJudgeRoute('xai-oauth/grok-4.5', ['xai-oauth/grok-4.5', 'claude-oauth/claude-fable-5']),
    ).toBe('claude-oauth/claude-fable-5');
  });

  it('returns null when no independent route exists — caller must HOLD', () => {
    expect(resolveJudgeRoute('a/b', ['a/b', ' A/B ', ''])).toBeNull();
    expect(resolveJudgeRoute('a/b', [])).toBeNull();
  });
});

describe('runGate with a judge declaration', () => {
  const baseline = summary('base', [['t1', true], ['t2', true]]);
  const current = summary('cur', [['t1', true], ['t2', true]]);

  it('holds (exit 1, no verdict) when the judge is the candidate — even on a passing run', () => {
    const out = runGate({
      baseline,
      current,
      judge: { judgeRoute: 'a/b', candidateRoute: 'a/b' },
    });
    expect(out.held).toBe(true);
    expect(out.exitCode).toBe(1);
    expect(out.verdict).toBeNull();
    expect(out.holdReason).toContain('route under test');
    expect(out.markdown).toContain('HOLD');
  });

  it('holds even when there is no baseline — a held run never establishes one', () => {
    const out = runGate({
      baseline: null,
      current,
      judge: { judgeRoute: 'a/b', candidateRoute: 'a/b' },
    });
    expect(out.held).toBe(true);
    expect(out.exitCode).toBe(1);
    expect(out.baselineMissing).toBe(true);
  });

  it('gates on merit when the judge is independent', () => {
    const out = runGate({
      baseline,
      current,
      judge: { judgeRoute: 'c/d', candidateRoute: 'a/b' },
    });
    expect(out.held).toBeUndefined();
    expect(out.exitCode).toBe(0);
    expect(out.verdict).not.toBeNull();
  });

  it('leaves verifier-only runs (no judge declaration) untouched', () => {
    const out = runGate({ baseline, current });
    expect(out.held).toBeUndefined();
    expect(out.exitCode).toBe(0);
  });
});
