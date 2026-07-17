/**
 * @file goal-evaluator.test.ts
 * @description Tests for HeuristicGoalEvaluator and createGoalEvaluator factory.
 * Covers spec §7 Builder C tests 1–10.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  HeuristicGoalEvaluator,
  createGoalEvaluator,
  type EvalContext,
} from '../../src/core/outcomes/goal-evaluator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    sessionId: 'test-session-1',
    goal: 'Complete the task',
    recentMessages: [],
    toolSuccessCount: 0,
    toolFailureCount: 0,
    ...overrides,
  };
}

function msg(role: string, content: string) {
  return { role, content };
}

// ---------------------------------------------------------------------------
// 1–5: HeuristicGoalEvaluator
// ---------------------------------------------------------------------------

describe('HeuristicGoalEvaluator', () => {
  let evaluator: HeuristicGoalEvaluator;

  beforeEach(() => {
    evaluator = new HeuristicGoalEvaluator();
  });

  it('1: returns success when last 5 messages contain "done" and tool ratio >= 0.6', async () => {
    const ctx = makeCtx({
      recentMessages: [
        msg('assistant', 'I am done with the task'),
      ],
      toolSuccessCount: 6,
      toolFailureCount: 4,
    });
    const result = await evaluator.evaluate(ctx);
    expect(result.outcome).toBe('success');
    expect(result.confidence).toBe(0.4);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('2: returns success when last message contains "completed" and ratio >= 0.6', async () => {
    const ctx = makeCtx({
      recentMessages: [msg('assistant', 'All steps have been completed successfully')],
      toolSuccessCount: 8,
      toolFailureCount: 2,
    });
    const result = await evaluator.evaluate(ctx);
    expect(result.outcome).toBe('success');
  });

  it('3: returns success for "finished" keyword with adequate tool ratio', async () => {
    const ctx = makeCtx({
      recentMessages: [msg('assistant', 'The analysis is finished')],
      toolSuccessCount: 7,
      toolFailureCount: 3,
    });
    const result = await evaluator.evaluate(ctx);
    expect(result.outcome).toBe('success');
  });

  it('4: returns failure when tool ratio < 0.3', async () => {
    const ctx = makeCtx({
      recentMessages: [msg('assistant', 'Attempting to run the command')],
      toolSuccessCount: 1,
      toolFailureCount: 9,
    });
    const result = await evaluator.evaluate(ctx);
    expect(result.outcome).toBe('failure');
    expect(result.confidence).toBe(0.4);
  });

  it('5: returns failure when last message contains "error"', async () => {
    const ctx = makeCtx({
      recentMessages: [msg('assistant', 'An error occurred during execution')],
      toolSuccessCount: 5,
      toolFailureCount: 5,
    });
    const result = await evaluator.evaluate(ctx);
    expect(result.outcome).toBe('failure');
  });

  it('5b: returns partial for empty messages (no tools → no signal, not auto-failure)', async () => {
    // A zero-tool session is no longer auto-classified as failure on a 0/0
    // ratio (that override was the bug); with no failure or success signal it
    // is 'partial' (honest uncertainty), not 'failure'.
    const ctx = makeCtx({
      recentMessages: [],
      toolSuccessCount: 0,
      toolFailureCount: 0,
    });
    const result = await evaluator.evaluate(ctx);
    expect(result.outcome).toBe('partial');
    expect(result.confidence).toBe(0.4);
  });

  it('returns failure when last message contains "failed"', async () => {
    const ctx = makeCtx({
      recentMessages: [msg('assistant', 'The operation failed to complete')],
      toolSuccessCount: 5,
      toolFailureCount: 5,
    });
    const result = await evaluator.evaluate(ctx);
    expect(result.outcome).toBe('failure');
  });

  it('returns failure when last message contains "cannot"', async () => {
    const ctx = makeCtx({
      recentMessages: [msg('assistant', 'I cannot complete this request')],
      toolSuccessCount: 8,
      toolFailureCount: 2,
    });
    const result = await evaluator.evaluate(ctx);
    expect(result.outcome).toBe('failure');
  });

  it('returns partial when success keyword present but tool ratio < 0.6', async () => {
    const ctx = makeCtx({
      recentMessages: [msg('assistant', 'Some steps are done')],
      toolSuccessCount: 3,
      toolFailureCount: 7, // ratio = 0.3, not below 0.3 threshold but not above 0.6
    });
    // ratio = 0.3 which is NOT < 0.3 (failure threshold), but < 0.6 (success threshold)
    // keyword "done" is present, but ratio not high enough → partial
    const result = await evaluator.evaluate(ctx);
    expect(result.outcome).toBe('partial');
    expect(result.confidence).toBe(0.4);
  });

  it('returns partial when tool ratio >= 0.6 but no success keywords', async () => {
    const ctx = makeCtx({
      recentMessages: [msg('assistant', 'I am working on it now')],
      toolSuccessCount: 8,
      toolFailureCount: 2,
    });
    const result = await evaluator.evaluate(ctx);
    expect(result.outcome).toBe('partial');
  });

  it('confidence is always 0.4 regardless of outcome', async () => {
    const successCtx = makeCtx({
      recentMessages: [msg('assistant', 'done')],
      toolSuccessCount: 9,
      toolFailureCount: 1,
    });
    const failCtx = makeCtx({
      recentMessages: [msg('assistant', 'error happened')],
      toolSuccessCount: 0,
      toolFailureCount: 10,
    });
    const partialCtx = makeCtx({
      recentMessages: [msg('assistant', 'still working')],
      toolSuccessCount: 5,
      toolFailureCount: 5,
    });

    const [s, f, p] = await Promise.all([
      evaluator.evaluate(successCtx),
      evaluator.evaluate(failCtx),
      evaluator.evaluate(partialCtx),
    ]);

    expect(s.confidence).toBe(0.4);
    expect(f.confidence).toBe(0.4);
    expect(p.confidence).toBe(0.4);
  });

  it('evidence array is non-empty for all outcomes', async () => {
    const ctx = makeCtx({
      recentMessages: [msg('assistant', 'done and completed')],
      toolSuccessCount: 8,
      toolFailureCount: 2,
    });
    const result = await evaluator.evaluate(ctx);
    expect(Array.isArray(result.evidence)).toBe(true);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('only uses last 5 messages for success keyword check', async () => {
    // Put "done" in the 6th-from-last message only — should NOT trigger success
    const messages = [
      msg('assistant', 'done successfully'),      // 6th from end
      msg('assistant', 'message 5'),
      msg('assistant', 'message 4'),
      msg('assistant', 'message 3'),
      msg('assistant', 'message 2'),
      msg('assistant', 'working on it'),          // last 5 start here
    ];
    const ctx = makeCtx({
      recentMessages: messages,
      toolSuccessCount: 8,
      toolFailureCount: 2,
    });
    const result = await evaluator.evaluate(ctx);
    // "done" is not in the last 5 messages, ratio is 0.8 >= 0.6 but no keyword → partial
    expect(result.outcome).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// 6–10: createGoalEvaluator factory
// ---------------------------------------------------------------------------

describe('createGoalEvaluator', () => {
  afterEach(() => {
    delete process.env['SUDO_GOAL_EVAL_MODEL'];
  });

  it('6: returns HeuristicGoalEvaluator by default (no env var)', () => {
    delete process.env['SUDO_GOAL_EVAL_MODEL'];
    const evaluator = createGoalEvaluator();
    expect(evaluator).toBeInstanceOf(HeuristicGoalEvaluator);
  });

  it('7: returns LlmGoalEvaluator when SUDO_GOAL_EVAL_MODEL=haiku AND a caller is injected', () => {
    process.env['SUDO_GOAL_EVAL_MODEL'] = 'haiku';
    const evaluator = createGoalEvaluator(async () => '{}');
    expect(evaluator).not.toBeInstanceOf(HeuristicGoalEvaluator);
  });

  it('7b: model set but NO caller injected → heuristic (seam not provided)', () => {
    process.env['SUDO_GOAL_EVAL_MODEL'] = 'haiku';
    const evaluator = createGoalEvaluator();
    expect(evaluator).toBeInstanceOf(HeuristicGoalEvaluator);
  });

  it('8: LlmGoalEvaluator returns a valid GoalEvalResult shape', async () => {
    process.env['SUDO_GOAL_EVAL_MODEL'] = 'haiku';
    const evaluator = createGoalEvaluator(async () => '{"outcome":"success","confidence":0.9,"evidence":["all tools green"]}');
    const result = await evaluator.evaluate(makeCtx({
      recentMessages: [msg('assistant', 'done')],
      toolSuccessCount: 8,
      toolFailureCount: 2,
    }));
    expect(['success', 'failure', 'partial']).toContain(result.outcome);
    expect(typeof result.confidence).toBe('number');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(result.evidence)).toBe(true);
  });

  it('9: factory is idempotent — calling twice produces equivalent evaluators', () => {
    delete process.env['SUDO_GOAL_EVAL_MODEL'];
    const a = createGoalEvaluator();
    const b = createGoalEvaluator();
    expect(a.constructor).toBe(b.constructor);
  });

  it('10: wrong env value (not "haiku") returns HeuristicGoalEvaluator', () => {
    process.env['SUDO_GOAL_EVAL_MODEL'] = 'gpt4';
    const evaluator = createGoalEvaluator();
    expect(evaluator).toBeInstanceOf(HeuristicGoalEvaluator);
  });
});

describe('LlmGoalEvaluator (F88)', () => {
  const mkEval = (reply: () => Promise<string>) => {
    process.env['SUDO_GOAL_EVAL_MODEL'] = 'haiku';
    const e = createGoalEvaluator(reply);
    delete process.env['SUDO_GOAL_EVAL_MODEL'];
    return e;
  };

  it('accepts a strict-JSON verdict', async () => {
    const e = mkEval(async () => '{"outcome":"failure","confidence":0.8,"evidence":["tests failed"]}');
    const r = await e.evaluate(makeCtx({}));
    expect(r).toEqual({ outcome: 'failure', confidence: 0.8, evidence: ['tests failed'] });
  });

  it('tolerates fenced/prosey replies by extracting the JSON block', async () => {
    const e = mkEval(async () => 'Sure!\n```json\n{"outcome":"partial","confidence":0.5,"evidence":[]}\n```');
    const r = await e.evaluate(makeCtx({}));
    expect(r.outcome).toBe('partial');
    expect(r.confidence).toBe(0.5);
  });

  it('clamps out-of-range confidence', async () => {
    const e = mkEval(async () => '{"outcome":"success","confidence":7,"evidence":[]}');
    const r = await e.evaluate(makeCtx({}));
    expect(r.confidence).toBe(1);
  });

  it('falls back to heuristic on unparseable reply, with honest evidence', async () => {
    const e = mkEval(async () => 'I think it went fine.');
    const r = await e.evaluate(makeCtx({ recentMessages: [msg('assistant', 'error: failed')] }));
    expect(r.outcome).toBe('failure'); // heuristic verdict
    expect(r.evidence).toContain('LLM evaluation unavailable — heuristic fallback');
  });

  it('falls back to heuristic when the call throws', async () => {
    const e = mkEval(async () => { throw new Error('provider down'); });
    const r = await e.evaluate(makeCtx({}));
    expect(['success', 'failure', 'partial']).toContain(r.outcome);
    expect(r.evidence).toContain('LLM evaluation unavailable — heuristic fallback');
  });

  it('rejects invalid outcome values → fallback', async () => {
    const e = mkEval(async () => '{"outcome":"maybe","confidence":0.5,"evidence":[]}');
    const r = await e.evaluate(makeCtx({}));
    expect(r.evidence).toContain('LLM evaluation unavailable — heuristic fallback');
  });
});
