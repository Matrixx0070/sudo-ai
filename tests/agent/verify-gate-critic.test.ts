/**
 * @file verify-gate-critic.test.ts
 * Unit tests for the slice-3 CriticPass.
 *
 * Verdict parser, budget gate, soft-skip routing, no-brain / brain-throws /
 * malformed-output fail-open semantics. Integration with executeToolCalls
 * lives in verify-gate-integration.test.ts (slice-3 branches).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CriticPass,
  parseVerdict,
  readCriticBudget,
  readCriticFeedbackEnabled,
  renderCriticFeedback,
  CRITIC_FEEDBACK_PREFIX,
  type CriticBrainLike,
  type CriticReviewInput,
} from '../../src/core/agent/verify-gate-critic.js';

function makeInput(overrides: Partial<CriticReviewInput> = {}): CriticReviewInput {
  return {
    sessionId: 'sess-A',
    toolName: 'coder.write-file',
    args: { file_path: '/tmp/x.txt', old_string: 'absent' },
    trigger: 'grounding-failed',
    confidence: 0.2,
    threshold: 0.55,
    evidence: { reason: 'edit-grounding-fail', filePath: '/tmp/x.txt' },
    ...overrides,
  };
}

describe('parseVerdict', () => {
  it('accepts APPROVE with rationale', () => {
    const r = parseVerdict('APPROVE: file exists, edit is reversible');
    expect(r).toEqual({ verdict: 'approve', rationale: 'file exists, edit is reversible' });
  });

  it('accepts REJECT with rationale, case-insensitive', () => {
    const r = parseVerdict('reject: old_string not present in file');
    expect(r).toEqual({ verdict: 'reject', rationale: 'old_string not present in file' });
  });

  it('skips leading blank lines, takes first verdict line', () => {
    const r = parseVerdict('\n\n   \nAPPROVE: ok\nignored second line');
    expect(r).toEqual({ verdict: 'approve', rationale: 'ok' });
  });

  it('truncates excessively long rationale', () => {
    const long = 'x'.repeat(1000);
    const r = parseVerdict(`APPROVE: ${long}`);
    expect(r?.verdict).toBe('approve');
    expect((r?.rationale ?? '').length).toBeLessThanOrEqual(280);
  });

  it('returns null on no verdict line', () => {
    expect(parseVerdict('I think this is fine.')).toBeNull();
    expect(parseVerdict('')).toBeNull();
    expect(parseVerdict('\n\n')).toBeNull();
  });
});

describe('readCriticBudget', () => {
  it('defaults to 3 when env is absent', () => {
    expect(readCriticBudget({} as NodeJS.ProcessEnv)).toBe(3);
  });

  it('accepts a clean non-negative integer', () => {
    expect(readCriticBudget({ SUDO_VERIFY_GATE_CRITIC_BUDGET: '7' } as unknown as NodeJS.ProcessEnv)).toBe(7);
    expect(readCriticBudget({ SUDO_VERIFY_GATE_CRITIC_BUDGET: '0' } as unknown as NodeJS.ProcessEnv)).toBe(0);
  });

  it('rejects junk and falls back to default', () => {
    for (const v of ['', '   ', '-1', '2.5', '0x10', '3x', 'abc']) {
      expect(readCriticBudget({ SUDO_VERIFY_GATE_CRITIC_BUDGET: v } as unknown as NodeJS.ProcessEnv)).toBe(3);
    }
  });
});

describe('CriticPass.review', () => {
  it('soft-skips when trigger is low-confidence — never calls brain', async () => {
    const brain: CriticBrainLike = {
      call: vi.fn(async () => ({ content: 'APPROVE: shouldn\'t run' })),
    };
    const cp = new CriticPass(brain);
    const r = await cp.review(makeInput({ trigger: 'low-confidence' }));
    expect(r).toEqual({ invoked: false, verdict: 'skip', reason: 'soft-skip' });
    expect(brain.call).not.toHaveBeenCalled();
    expect(cp.invocationsFor('sess-A')).toBe(0);
  });

  it('returns no-brain skip when brain is undefined', async () => {
    const cp = new CriticPass(undefined);
    const r = await cp.review(makeInput());
    expect(r).toEqual({ invoked: false, verdict: 'skip', reason: 'no-brain' });
  });

  it('invokes brain on grounding-failed and parses APPROVE', async () => {
    const brain: CriticBrainLike = {
      call: vi.fn(async () => ({ content: 'APPROVE: target file exists\nIgnored extra line' })),
    };
    const cp = new CriticPass(brain, { budget: 5 });
    const r = await cp.review(makeInput());
    expect(r.invoked).toBe(true);
    expect(r.verdict).toBe('approve');
    expect(r.reason).toBe('invoked');
    expect(r.rationale).toBe('target file exists');
    expect(brain.call).toHaveBeenCalledTimes(1);
    expect(cp.invocationsFor('sess-A')).toBe(1);
  });

  it('invokes brain on grounding-failed and parses REJECT', async () => {
    const brain: CriticBrainLike = {
      call: vi.fn(async () => ({ content: 'REJECT: old_string not present' })),
    };
    const cp = new CriticPass(brain, { budget: 5 });
    const r = await cp.review(makeInput());
    expect(r.invoked).toBe(true);
    expect(r.verdict).toBe('reject');
    expect(r.rationale).toBe('old_string not present');
  });

  it('returns malformed skip when brain output has no verdict line', async () => {
    const brain: CriticBrainLike = {
      call: vi.fn(async () => ({ content: 'I think it depends.' })),
    };
    const cp = new CriticPass(brain, { budget: 5 });
    const r = await cp.review(makeInput());
    expect(r.invoked).toBe(false);
    expect(r.verdict).toBe('skip');
    expect(r.reason).toBe('malformed');
    // Budget IS consumed when the brain call succeeded — the spend already
    // happened. This is the conservative choice for runaway-protection.
    expect(cp.invocationsFor('sess-A')).toBe(1);
  });

  it('returns error skip when brain throws (fail-open)', async () => {
    const brain: CriticBrainLike = {
      call: vi.fn(async () => { throw new Error('network down'); }),
    };
    const cp = new CriticPass(brain, { budget: 5 });
    const r = await cp.review(makeInput());
    expect(r.invoked).toBe(false);
    expect(r.verdict).toBe('skip');
    expect(r.reason).toBe('error');
    // Budget IS consumed — increment happens before the await, intentional to
    // bound concurrent reviews from the same runaway agent.
    expect(cp.invocationsFor('sess-A')).toBe(1);
  });

  it('budget exhaustion blocks further brain calls in the same session', async () => {
    const brain: CriticBrainLike = {
      call: vi.fn(async () => ({ content: 'APPROVE: ok' })),
    };
    const cp = new CriticPass(brain, { budget: 2 });
    expect((await cp.review(makeInput())).invoked).toBe(true);
    expect((await cp.review(makeInput())).invoked).toBe(true);
    const third = await cp.review(makeInput());
    expect(third.invoked).toBe(false);
    expect(third.verdict).toBe('skip');
    expect(third.reason).toBe('budget-exhausted');
    // MED-2: rationale on budget-exhausted carries errors=K/N so ops can
    // distinguish "flaky provider" from "real reviews" without correlation.
    expect(third.rationale).toBe('errors=0/2');
    expect(brain.call).toHaveBeenCalledTimes(2);
    expect(cp.invocationsFor('sess-A')).toBe(2);
    expect(cp.errorsFor('sess-A')).toBe(0);
  });

  it('budget-exhausted rationale reports error count when brain threw', async () => {
    const brain: CriticBrainLike = {
      call: vi.fn(async () => { throw new Error('flaky'); }),
    };
    const cp = new CriticPass(brain, { budget: 2 });
    // Two failed attempts burn the budget.
    expect((await cp.review(makeInput())).reason).toBe('error');
    expect((await cp.review(makeInput())).reason).toBe('error');
    const third = await cp.review(makeInput());
    expect(third.reason).toBe('budget-exhausted');
    expect(third.rationale).toBe('errors=2/2');
    expect(cp.errorsFor('sess-A')).toBe(2);
  });

  it('budget is tracked per session', async () => {
    const brain: CriticBrainLike = {
      call: vi.fn(async () => ({ content: 'APPROVE: ok' })),
    };
    const cp = new CriticPass(brain, { budget: 1 });
    expect((await cp.review(makeInput({ sessionId: 'sess-A' }))).invoked).toBe(true);
    expect((await cp.review(makeInput({ sessionId: 'sess-A' }))).invoked).toBe(false);
    // Different session — budget is fresh.
    expect((await cp.review(makeInput({ sessionId: 'sess-B' }))).invoked).toBe(true);
    expect(cp.invocationsFor('sess-A')).toBe(1);
    expect(cp.invocationsFor('sess-B')).toBe(1);
  });

  it('budget = 0 disables LLM invocation entirely', async () => {
    const brain: CriticBrainLike = {
      call: vi.fn(async () => ({ content: 'APPROVE: ok' })),
    };
    const cp = new CriticPass(brain, { budget: 0 });
    const r = await cp.review(makeInput());
    expect(r.invoked).toBe(false);
    expect(r.reason).toBe('budget-exhausted');
    expect(brain.call).not.toHaveBeenCalled();
  });

  it('resetForTests clears per-session counters (incl. error counts)', async () => {
    const brain: CriticBrainLike = {
      call: vi.fn(async () => { throw new Error('boom'); }),
    };
    const cp = new CriticPass(brain, { budget: 2 });
    await cp.review(makeInput());
    expect(cp.invocationsFor('sess-A')).toBe(1);
    expect(cp.errorsFor('sess-A')).toBe(1);
    cp.resetForTests();
    expect(cp.invocationsFor('sess-A')).toBe(0);
    expect(cp.errorsFor('sess-A')).toBe(0);
  });

  it('passes systemPrompt + reviewer directive in messages', async () => {
    const calls: Array<{ role: string; content: string }[]> = [];
    const brain: CriticBrainLike = {
      call: vi.fn(async (req) => {
        calls.push(req.messages.map((m) => ({ role: m.role, content: m.content })));
        return { content: 'APPROVE: ok' };
      }),
    };
    const cp = new CriticPass(brain, { systemPrompt: 'CUSTOM REVIEWER', budget: 5 });
    await cp.review(makeInput());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({ role: 'system', content: 'CUSTOM REVIEWER' });
    // Second system message carries the critic output contract.
    expect(calls[0]?.[1]?.role).toBe('system');
    expect(calls[0]?.[1]?.content).toMatch(/APPROVE:/);
    expect(calls[0]?.[1]?.content).toMatch(/REJECT:/);
    // User message names the tool + trigger + threshold.
    const user = calls[0]?.[2];
    expect(user?.role).toBe('user');
    expect(user?.content).toMatch(/coder\.write-file/);
    expect(user?.content).toMatch(/grounding-failed/);
    expect(user?.content).toMatch(/0\.55/);
    // MED-3: args + evidence wrapped in untrusted-content fences so a crafted
    // arg value can't pose as a verdict downstream.
    expect(user?.content).toMatch(/<args>/);
    expect(user?.content).toMatch(/<\/args>/);
    expect(user?.content).toMatch(/<evidence>/);
    expect(user?.content).toMatch(/<\/evidence>/);
  });
});

// ---------------------------------------------------------------------------
// Slice 4 — readCriticFeedbackEnabled + renderCriticFeedback
// ---------------------------------------------------------------------------

describe('readCriticFeedbackEnabled (slice 4)', () => {
  it('defaults to false when env is absent', () => {
    expect(readCriticFeedbackEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('returns true only on the literal string "1"', () => {
    expect(readCriticFeedbackEnabled({ SUDO_VERIFY_GATE_CRITIC_FEEDBACK: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it('rejects anything else (truthy strings included) — opt-in must be explicit', () => {
    for (const v of ['', '0', 'true', 'TRUE', 'yes', 'on', '01', '1 ', ' 1']) {
      expect(readCriticFeedbackEnabled({ SUDO_VERIFY_GATE_CRITIC_FEEDBACK: v } as unknown as NodeJS.ProcessEnv)).toBe(false);
    }
  });
});

describe('renderCriticFeedback (slice 4)', () => {
  it('produces a single line "<PREFIX> <rationale>" for a normal rationale', () => {
    const out = renderCriticFeedback('old_string not present in file');
    expect(out).toBe(`${CRITIC_FEEDBACK_PREFIX} old_string not present in file`);
  });

  it('trims surrounding whitespace from the rationale', () => {
    const out = renderCriticFeedback('   spaces around   ');
    expect(out).toBe(`${CRITIC_FEEDBACK_PREFIX} spaces around`);
  });

  it('falls back to "(no rationale)" on empty / whitespace / null / undefined', () => {
    const want = `${CRITIC_FEEDBACK_PREFIX} (no rationale)`;
    expect(renderCriticFeedback('')).toBe(want);
    expect(renderCriticFeedback('   ')).toBe(want);
    expect(renderCriticFeedback(null)).toBe(want);
    expect(renderCriticFeedback(undefined)).toBe(want);
  });

  it('clamps an oversized rationale to RATIONALE_MAX (defense-in-depth on bypass-parseVerdict callers)', () => {
    const long = 'x'.repeat(1000);
    const out = renderCriticFeedback(long);
    // PREFIX + space + at most 280 chars of body
    expect(out.length).toBe(CRITIC_FEEDBACK_PREFIX.length + 1 + 280);
    expect(out.startsWith(`${CRITIC_FEEDBACK_PREFIX} `)).toBe(true);
  });
});
