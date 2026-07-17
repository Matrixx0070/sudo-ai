import { describe, it, expect, afterEach } from 'vitest';
import {
  setPlanDeadEndMatcher,
  matchPlanDeadEnds,
  renderDeadEndWarning,
} from '../../src/core/agent/dead-end-seam.js';
import {
  setSecondOpinionRequester,
  requestSecondOpinion,
  secondOpinionEnabled,
  _resetSecondOpinionSeam,
  type SecondOpinionRequest,
} from '../../src/core/agent/second-opinion-seam.js';
import { runVetoGate, type VetoInput } from '../../src/core/agent/veto-gate.js';
import {
  setDebateRequester,
  requestDebate,
  debateEnabled,
  _resetDebateSeam,
  type DebateRequest,
} from '../../src/core/agent/debate-seam.js';

afterEach(() => {
  setPlanDeadEndMatcher(null);
  _resetSecondOpinionSeam();
  _resetDebateSeam();
});

describe('G-PLANNER — dead-end seam', () => {
  it('is a no-op until wired (returns [])', () => {
    expect(matchPlanDeadEnds('try browser.click on the stale selector')).toEqual([]);
    expect(renderDeadEndWarning([])).toBe('');
  });

  it('returns hits from the wired matcher and renders a warning block', () => {
    setPlanDeadEndMatcher((plan) =>
      plan.includes('browser.click') ? [{ summary: 'looping on stale selector', cause: 'selector rot' }] : [],
    );
    const hits = matchPlanDeadEnds('step 1: browser.click the button');
    expect(hits).toHaveLength(1);
    const warning = renderDeadEndWarning(hits);
    expect(warning).toContain('PREVIOUSLY-FAILED APPROACHES');
    expect(warning).toContain('looping on stale selector');
    expect(warning).toContain('selector rot');
  });

  it('fails open — a throwing matcher yields [] not an exception', () => {
    setPlanDeadEndMatcher(() => { throw new Error('store unavailable'); });
    expect(() => matchPlanDeadEnds('anything')).not.toThrow();
    expect(matchPlanDeadEnds('anything')).toEqual([]);
  });
});

describe('G-F32WIRE — second-opinion seam', () => {
  it('is disabled and a no-op until wired', () => {
    expect(secondOpinionEnabled()).toBe(false);
    expect(requestSecondOpinion({ key: 'k1', question: 'q', evidence: [], constraints: [], impact: 'critical' })).toBe(false);
  });

  it('dispatches a NEW request fire-and-forget and dedups repeats', async () => {
    const got: string[] = [];
    setSecondOpinionRequester(async (req) => { got.push(req.key); });
    expect(secondOpinionEnabled()).toBe(true);
    expect(requestSecondOpinion({ key: 'dup', question: 'q', evidence: [], constraints: [], impact: 'critical' })).toBe(true);
    expect(requestSecondOpinion({ key: 'dup', question: 'q', evidence: [], constraints: [], impact: 'critical' })).toBe(false); // deduped
    await Promise.resolve();
    expect(got).toEqual(['dup']);
  });

  it('the veto gate requests a second opinion on a CRITICAL-risk APPROVE', async () => {
    const got: SecondOpinionRequest[] = [];
    setSecondOpinionRequester(async (req) => { got.push(req); });
    // execCommand → CRITICAL risk; all models APPROVE → decision APPROVE.
    const input: VetoInput = { toolName: 'execCommand', args: { cmd: 'ls' } };
    const res = await runVetoGate(input, async () => 'APPROVE looks fine');
    expect(res.decision).toBe('APPROVE');
    expect(res.risk).toBe('CRITICAL');
    expect(got).toHaveLength(1);
    expect(got[0]!.impact).toBe('critical');
    expect(got[0]!.question).not.toMatch(/conclusion|recommendation|preferred|decision:/i);
  });

  it('does NOT request a second opinion on a non-critical APPROVE', async () => {
    const got: SecondOpinionRequest[] = [];
    setSecondOpinionRequester(async (req) => { got.push(req); });
    const res = await runVetoGate({ toolName: 'sendNotification', args: {} }, async () => 'APPROVE ok');
    expect(res.decision).toBe('APPROVE');
    expect(res.risk).toBe('MEDIUM');
    expect(got).toHaveLength(0);
  });

  it('the veto gate also requests a DEBATE on a CRITICAL-risk APPROVE (F48)', async () => {
    const got: DebateRequest[] = [];
    setDebateRequester(async (req) => { got.push(req); });
    expect(debateEnabled()).toBe(true);
    const res = await runVetoGate({ toolName: 'execCommand', args: { cmd: 'ls' } }, async () => 'APPROVE fine');
    expect(res.decision).toBe('APPROVE');
    expect(got).toHaveLength(1);
    expect(got[0]!.key).toMatch(/^debate-/);
    expect(got[0]!.question).not.toMatch(/conclusion|recommendation|preferred|decision:/i);
  });

  it('does not throw when the requester rejects, and re-allows retry of that key', async () => {
    let calls = 0;
    setSecondOpinionRequester(async () => { calls++; throw new Error('drive down'); });
    expect(requestSecondOpinion({ key: 'retry', question: 'q', evidence: [], constraints: [], impact: 'high' })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    // key forgotten after failure → a second request is dispatched again
    expect(requestSecondOpinion({ key: 'retry', question: 'q', evidence: [], constraints: [], impact: 'high' })).toBe(true);
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  it('debate seam: no-op until wired, dispatches once, dedups', async () => {
    expect(debateEnabled()).toBe(false);
    expect(requestDebate({ key: 'd', question: 'q', evidence: [], constraints: [] })).toBe(false);
    const got: string[] = [];
    setDebateRequester(async (req) => { got.push(req.key); });
    expect(requestDebate({ key: 'd', question: 'q', evidence: [], constraints: [] })).toBe(true);
    expect(requestDebate({ key: 'd', question: 'q', evidence: [], constraints: [] })).toBe(false);
    await Promise.resolve();
    expect(got).toEqual(['d']);
  });
});
