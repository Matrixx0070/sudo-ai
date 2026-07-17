/**
 * @file notebooklm/probe-gates.ts
 * @description The three gates that ride on E4's deterministic rubric scoring
 * and therefore run FULLY OFFLINE (no LLM, no external paste) — so they can be
 * exercised in CI and can block a background job on their own:
 *
 *   F61 Feynman gate   — BLOCKING. If the self reader cannot explain the core
 *                        concepts simply (rubric coverage below threshold), the
 *                        gate blocks; the caller must not promote/advance.
 *   F63 identity pulse  — ALERTING. Compares the current self answers on the
 *                        identity questions to a pinned baseline; if they drift
 *                        apart (token similarity below threshold) it raises an
 *                        alert (self-model change worth a human glance).
 *   F68 curriculum ladder — OFFLINE progression. A learner advances to the next
 *                        rung only when it clears the current rung's pass bar.
 *
 * All three consume a SelfRunResult (probe.ts) — no judge, no network.
 */

import { scoreRubric, type ProbeSet, type SelfRunResult } from './probe.js';

function answerFor(run: SelfRunResult, qid: string): string {
  return run.answers.find((a) => a.qid.toLowerCase() === qid.toLowerCase())?.answer ?? '';
}

/** Mean rubric ratio of a run against its set (self coverage of ground truth). */
export function selfCoverage(set: ProbeSet, run: SelfRunResult): number {
  if (set.questions.length === 0) return 0;
  const sum = set.questions.reduce(
    (a, q) => a + scoreRubric(answerFor(run, q.qid), q.rubric).ratio,
    0,
  );
  return sum / set.questions.length;
}

// ---------------------------------------------------------------------------
// F61 — Feynman gate (BLOCKING)
// ---------------------------------------------------------------------------

export interface FeynmanResult {
  pass: boolean;
  blocked: boolean;
  coverage: number;
  threshold: number;
  weakest: { qid: string; ratio: number } | null;
  reason: string;
}

/**
 * Blocks when the self reader can't cover the rubric of the "explain simply"
 * probe set. `blocked === !pass` — a hard gate a caller must honour before
 * promoting a belief or advancing a ladder.
 */
export function feynmanGate(set: ProbeSet, run: SelfRunResult, threshold = 0.5): FeynmanResult {
  const perQ = set.questions.map((q) => ({
    qid: q.qid,
    ratio: scoreRubric(answerFor(run, q.qid), q.rubric).ratio,
  }));
  const coverage = perQ.length ? perQ.reduce((a, p) => a + p.ratio, 0) / perQ.length : 0;
  const weakest = perQ.length ? perQ.reduce((w, p) => (p.ratio < w.ratio ? p : w)) : null;
  const pass = coverage >= threshold;
  return {
    pass,
    blocked: !pass,
    coverage,
    threshold,
    weakest,
    reason: pass
      ? `coverage ${(coverage * 100).toFixed(0)}% ≥ ${(threshold * 100).toFixed(0)}%`
      : `coverage ${(coverage * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}% — cannot explain simply${weakest ? ` (weakest ${weakest.qid})` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// F63 — identity pulse (ALERTING)
// ---------------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'i', 'my', 'me']);

function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

export interface IdentityPulseResult {
  alert: boolean;
  similarity: number;
  threshold: number;
  perQuestion: Array<{ qid: string; similarity: number }>;
  drifted: string[];
  reason: string;
}

/** Baseline is a frozen prior self run (same set). */
export function identityPulse(
  set: ProbeSet,
  current: SelfRunResult,
  baseline: SelfRunResult,
  threshold = 0.5,
): IdentityPulseResult {
  const perQuestion = set.questions.map((q) => ({
    qid: q.qid,
    similarity: jaccard(tokens(answerFor(current, q.qid)), tokens(answerFor(baseline, q.qid))),
  }));
  const similarity = perQuestion.length
    ? perQuestion.reduce((a, p) => a + p.similarity, 0) / perQuestion.length
    : 1;
  const drifted = perQuestion.filter((p) => p.similarity < threshold).map((p) => p.qid);
  const alert = similarity < threshold;
  return {
    alert,
    similarity,
    threshold,
    perQuestion,
    drifted,
    reason: alert
      ? `identity similarity ${(similarity * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}% — drift on ${drifted.join(', ') || 'multiple'}`
      : `identity stable at ${(similarity * 100).toFixed(0)}%`,
  };
}

// ---------------------------------------------------------------------------
// F68 — curriculum ladder (OFFLINE progression)
// ---------------------------------------------------------------------------

export interface LadderRung {
  set: ProbeSet;
  /** Min self coverage to clear this rung. */
  pass: number;
}

export interface CurriculumLadder {
  id: string;
  rungs: LadderRung[];
}

export interface LadderResult {
  ladderId: string;
  rungIndex: number;
  rungSetId: string;
  coverage: number;
  pass: number;
  passed: boolean;
  advancedTo: number | null;
  done: boolean;
  reason: string;
}

/**
 * Evaluate a run against the learner's current rung. Advances by exactly one
 * rung on a pass; holds on a fail. Pure/offline — the F68 acceptance test.
 */
export function evaluateLadder(
  ladder: CurriculumLadder,
  rungIndex: number,
  run: SelfRunResult,
): LadderResult {
  const rung = ladder.rungs[rungIndex];
  if (!rung) throw new Error(`ladder ${ladder.id} has no rung ${rungIndex}`);
  const coverage = selfCoverage(rung.set, run);
  const passed = coverage >= rung.pass;
  const isLast = rungIndex >= ladder.rungs.length - 1;
  const advancedTo = passed && !isLast ? rungIndex + 1 : null;
  return {
    ladderId: ladder.id,
    rungIndex,
    rungSetId: rung.set.id,
    coverage,
    pass: rung.pass,
    passed,
    advancedTo,
    done: passed && isLast,
    reason: passed
      ? isLast
        ? 'cleared final rung — curriculum complete'
        : `cleared rung ${rungIndex} → advance to ${rungIndex + 1}`
      : `held at rung ${rungIndex}: coverage ${(coverage * 100).toFixed(0)}% < ${(rung.pass * 100).toFixed(0)}%`,
  };
}
