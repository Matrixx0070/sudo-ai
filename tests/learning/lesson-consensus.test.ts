/**
 * F86 — two-reader consensus gate for repair-flywheel APPLY.
 *
 * Proves invariant 9 (no promotion without OWN-verification AND an independent reader
 * agreeing), invariant 10 (daily cap + per-run budget, fail-closed), the audit trail,
 * invariant 7 (judge route ≠ author route), and default-OFF byte-identical behavior.
 *
 * DATA_DIR is captured at module import, so it is set BEFORE the dynamic import.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmp: string;
let apply: typeof import('../../src/core/learning/lesson-apply.js');
let consensus: typeof import('../../src/core/learning/lesson-consensus.js');

const NOW_ISO = '2026-07-19T12:00:00.000Z';
const START_ISO = '2026-07-19T11:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

/** A canary lesson whose window has elapsed, ready to be judged for promotion. */
function canaryLesson(overrides: Record<string, unknown> = {}): unknown {
  return {
    lessonId: 'exec-guard',
    tool: 'system.exec',
    hint: 'Use a single allowlisted repo command — no pipes.',
    state: 'canary',
    recoveryPct: 90,
    admittedAt: START_ISO,
    canaryStartedAt: START_ISO,
    canaryWindowMs: 1000,
    baselineFailRate: 0.5,
    minCanaryCalls: 20,
    maxCanaryWindowMs: 100_000,
    errorPattern: 'Refused:',
    authorRoute: 'sudo/mid', // xai — independent of the anthropic judge
    ...overrides,
  };
}

function writeStore(lessons: unknown[]): void {
  writeFileSync(apply.lessonStorePath(), JSON.stringify({ version: 1, lessons }));
}
function readStore(): { lessons: Array<{ lessonId: string; state: string }> } {
  return JSON.parse(readFileSync(apply.lessonStorePath(), 'utf8'));
}
function auditRows(): Array<Record<string, unknown>> {
  const p = consensus.auditLedgerPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Measurer that always reports a big improvement over ample traffic → would-promote. */
const improvingDeps = { measureClusterRate: () => ({ rate: 0.2, calls: 100 }), nowMs: NOW_MS, nowISO: NOW_ISO };
const GOV = { dailyCap: 3, perRunUsdBudget: 1, perRunTokenBudget: 100_000, estPerReadUsd: 0.02, estPerReadTokens: 1_500 };

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'f86-consensus-'));
  process.env['DATA_DIR'] = tmp;
  apply = await import('../../src/core/learning/lesson-apply.js');
  consensus = await import('../../src/core/learning/lesson-consensus.js');
});

beforeEach(() => {
  process.env['SUDO_FLYWHEEL_APPLY'] = '1';
  try { rmSync(consensus.auditLedgerPath(), { force: true }); } catch { /* */ }
  writeStore([canaryLesson()]);
  apply.invalidateHintCache();
});

afterAll(() => {
  delete process.env['SUDO_FLYWHEEL_APPLY'];
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

describe('consensus AGREE → promote', () => {
  it('promotes when reader 1 (own) and reader 2 (independent) BOTH agree, and audits it', async () => {
    let calls = 0;
    const reader = async () => { calls++; return { available: true as const, agree: true, reason: 'AGREE safe', judgeRoute: 'anthropic/claude-haiku-4-5-20251001', tokensUsed: 120, usdUsed: 0.001 }; };
    const actions = await apply.runLessonApplyConsensus(improvingDeps, reader, GOV);
    expect(calls).toBe(1);
    expect(actions.map((a) => a.action)).toContain('promoted');
    expect(readStore().lessons[0]!.state).toBe('promoted'); // surgery executed
    const promotedRows = auditRows().filter((r) => r.event === 'promoted');
    expect(promotedRows).toHaveLength(1);
    expect(promotedRows[0]!.reader1).toMatchObject({ promote: true });
    expect((promotedRows[0]!.reader2 as Record<string, unknown>).agree).toBe(true);
    expect(typeof promotedRows[0]!.lessonHash).toBe('string');
    expect(typeof promotedRows[0]!.storeHash).toBe('string');
  });
});

describe('consensus DISAGREE → escalate, never execute', () => {
  it('does NOT promote when the independent reader disagrees; audits an escalation', async () => {
    const reader = async () => ({ available: true as const, agree: false, reason: 'DISAGREE risky', judgeRoute: 'anthropic/claude-haiku-4-5-20251001', tokensUsed: 90, usdUsed: 0.001 });
    const actions = await apply.runLessonApplyConsensus(improvingDeps, reader, GOV);
    expect(actions.map((a) => a.action)).toContain('escalated');
    expect(actions.map((a) => a.action)).not.toContain('promoted');
    expect(readStore().lessons[0]!.state).toBe('canary'); // unchanged — no surgery
    expect(auditRows().filter((r) => r.event === 'escalated')).toHaveLength(1);
    expect(auditRows().filter((r) => r.event === 'promoted')).toHaveLength(0);
  });

  it('no INDEPENDENT reader (unavailable) → escalate, never execute', async () => {
    const reader = async () => ({ available: false as const, reason: 'no independent judge — same provider' });
    const actions = await apply.runLessonApplyConsensus(improvingDeps, reader, GOV);
    expect(actions.map((a) => a.action)).toContain('escalated');
    expect(readStore().lessons[0]!.state).toBe('canary');
    const row = auditRows().find((r) => r.event === 'escalated')!;
    expect((row.reader2 as Record<string, unknown>).available).toBe(false);
  });
});

describe('daily cap exhaustion → refuse (invariant 10)', () => {
  it('refuses promotion and does NOT even call the reader once the cap is spent', async () => {
    // Pre-seed the ledger with dailyCap promotions for TODAY.
    for (let i = 0; i < GOV.dailyCap; i++) {
      consensus.appendApplyAudit({ ts: NOW_ISO, event: 'promoted', lessonId: `prev-${i}`, tool: 't', reader1: { promote: true, reason: 'x' }, lessonHash: 'h', storeHash: 's' });
    }
    let calls = 0;
    const reader = async () => { calls++; return { available: true as const, agree: true, reason: 'AGREE', judgeRoute: 'anthropic/h', tokensUsed: 1, usdUsed: 0 }; };
    const actions = await apply.runLessonApplyConsensus(improvingDeps, reader, GOV);
    expect(calls).toBe(0); // budget/cap gate is BEFORE the paid reader call
    expect(actions.map((a) => a.action)).not.toContain('promoted');
    expect(readStore().lessons[0]!.state).toBe('canary');
    expect(auditRows().filter((r) => r.event === 'refused-cap')).toHaveLength(1);
  });
});

describe('per-run budget exhaustion → refuse, fail-closed (invariant 10)', () => {
  it('refuses when the estimated reader cost would exceed the per-run USD budget', async () => {
    const tinyBudget = { ...GOV, perRunUsdBudget: 0.01, estPerReadUsd: 0.02 }; // one read would blow it
    let calls = 0;
    const reader = async () => { calls++; return { available: true as const, agree: true, reason: 'AGREE', judgeRoute: 'anthropic/h', tokensUsed: 1, usdUsed: 0 }; };
    const actions = await apply.runLessonApplyConsensus(improvingDeps, reader, tinyBudget);
    expect(calls).toBe(0);
    expect(actions.map((a) => a.action)).not.toContain('promoted');
    expect(auditRows().filter((r) => r.event === 'refused-budget')).toHaveLength(1);
  });
});

describe('default OFF → byte-identical (no disk read, no promotion, no audit)', () => {
  it('returns [] and touches nothing when SUDO_FLYWHEEL_APPLY is unset', async () => {
    delete process.env['SUDO_FLYWHEEL_APPLY'];
    rmSync(consensus.auditLedgerPath(), { force: true });
    let calls = 0;
    const reader = async () => { calls++; return { available: true as const, agree: true, reason: 'AGREE', judgeRoute: 'anthropic/h', tokensUsed: 1, usdUsed: 0 }; };
    const actions = await apply.runLessonApplyConsensus(improvingDeps, reader, GOV);
    expect(actions).toEqual([]);
    expect(calls).toBe(0);
    expect(existsSync(consensus.auditLedgerPath())).toBe(false); // no audit written
    expect(readStore().lessons[0]!.state).toBe('canary');        // store untouched
  });
});

describe('judge independence (invariant 7): judge route ≠ author route', () => {
  it('makeJudgeConsensusReader reads when the judge provider differs from the author', async () => {
    let seenRoute = '';
    const chat = async (route: string) => { seenRoute = route; return { text: 'AGREE looks safe', tokensIn: 50, tokensOut: 10 }; };
    const reader = consensus.makeJudgeConsensusReader(chat);
    // author sudo/mid → xai/*, default judge sudo/judge → anthropic/* → independent.
    const v = await reader({ lessonId: 'l', tool: 't', hint: 'h', baselineFailRate: 0.5, canaryFailRate: 0.2, canaryCalls: 100, authorRoute: 'sudo/mid' });
    expect(v.available).toBe(true);
    if (v.available) {
      expect(consensus.judgeIndependenceOk('sudo/mid')).toBe(true);
      // chat was called with the JUDGE route (anthropic), not the xai author route.
      expect(seenRoute.split('/')[0]).toBe('anthropic');
      expect(v.judgeRoute).toBe(seenRoute);
      expect(v.judgeRoute.split('/')[0]).not.toBe('xai'); // author (sudo/mid) is xai
      expect(v.agree).toBe(true);
    }
  });

  it('HOLDS (unavailable) when the author shares the judge provider — no self-grading', async () => {
    const chat = async () => ({ text: 'AGREE', tokensIn: 1, tokensOut: 1 });
    const reader = consensus.makeJudgeConsensusReader(chat);
    // Force the author onto the same provider as the default judge (anthropic).
    const v = await reader({ lessonId: 'l', tool: 't', hint: 'h', baselineFailRate: 0.5, canaryFailRate: 0.2, canaryCalls: 100, authorRoute: 'anthropic/claude-opus-4-8' });
    expect(v.available).toBe(false);
    expect(consensus.judgeIndependenceOk('anthropic/claude-opus-4-8')).toBe(false);
  });
});

describe('pure helpers', () => {
  it('consensusOutcome: promote only on available+agree', () => {
    expect(consensus.consensusOutcome({ available: true, agree: true, reason: '', judgeRoute: 'j', tokensUsed: 0, usdUsed: 0 })).toBe('promote');
    expect(consensus.consensusOutcome({ available: true, agree: false, reason: '', judgeRoute: 'j', tokensUsed: 0, usdUsed: 0 })).toBe('escalate');
    expect(consensus.consensusOutcome({ available: false, reason: 'x' })).toBe('escalate');
  });
  it('budgetAllows is fail-closed on the estimate', () => {
    expect(consensus.budgetAllows({ spentUsd: 0, spentTokens: 0 }, GOV)).toBe(true);
    expect(consensus.budgetAllows({ spentUsd: 1, spentTokens: 0 }, GOV)).toBe(false);
    expect(consensus.budgetAllows({ spentUsd: 0, spentTokens: 100_000 }, GOV)).toBe(false);
  });
  it('parseAgree: DISAGREE wins ties, default no', () => {
    expect(consensus.parseAgree('AGREE fine')).toBe(true);
    expect(consensus.parseAgree('DISAGREE risky')).toBe(false);
    expect(consensus.parseAgree('AGREE but also DISAGREE')).toBe(false);
    expect(consensus.parseAgree('unclear')).toBe(false);
  });
  it('countPromotionsToday counts only same-UTC-day promoted rows', () => {
    rmSync(consensus.auditLedgerPath(), { force: true });
    consensus.appendApplyAudit({ ts: '2026-07-19T01:00:00Z', event: 'promoted', lessonId: 'a', tool: 't', reader1: { promote: true, reason: '' }, lessonHash: 'h', storeHash: 's' });
    consensus.appendApplyAudit({ ts: '2026-07-19T23:00:00Z', event: 'escalated', lessonId: 'b', tool: 't', reader1: { promote: true, reason: '' }, lessonHash: 'h', storeHash: 's' });
    consensus.appendApplyAudit({ ts: '2026-07-18T23:00:00Z', event: 'promoted', lessonId: 'c', tool: 't', reader1: { promote: true, reason: '' }, lessonHash: 'h', storeHash: 's' });
    expect(consensus.countPromotionsToday('2026-07-19T12:00:00Z')).toBe(1);
  });
});
