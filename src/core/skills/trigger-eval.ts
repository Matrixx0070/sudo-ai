/**
 * @file trigger-eval.ts
 * @description Trigger-quality evaluation and optimization for markdown
 * skills — measures whether a skill's trigger phrases fire for the right
 * user messages and stay quiet for the wrong ones, then optionally proposes
 * better phrases.
 *
 * The evaluation layer is FREE and exact: it runs the REAL runtime matcher
 * (skill-activator's matchTriggers — the same function the agent loop uses),
 * so a passing eval is a statement about production behavior, not about a
 * reimplementation. That also makes the optimization loop cheap: each
 * iteration costs one brain call (the proposal); re-scoring costs nothing.
 *
 * Loop rigor (patterns adopted from the anthropics/skills skill-creator,
 * Apache-2.0):
 *   - stratified, seeded train/test split (deterministic across runs)
 *   - the proposal model NEVER sees held-out scores (test-blinded history)
 *   - every prior attempt is fed back tagged "do not repeat"
 *   - the winner is selected by TEST accuracy, not train
 */

import { createLogger } from '../shared/logger.js';
import { matchTriggers, type ActivatableSkill } from './skill-activator.js';

const log = createLogger('skills:trigger-eval');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TriggerEvalCase {
  query: string;
  shouldTrigger: boolean;
}

export interface TriggerCaseResult extends TriggerEvalCase {
  triggered: boolean;
  matchedPhrase?: string;
  pass: boolean;
}

export interface ConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  accuracy: number;
}

export interface TriggerEvalReport {
  skillName: string;
  triggers: string[];
  results: TriggerCaseResult[];
  matrix: ConfusionMatrix;
}

export interface OptimizeIteration {
  iteration: number;
  triggers: string[];
  trainAccuracy: number;
  testAccuracy: number | null;
  trainFailures: TriggerCaseResult[];
}

export interface OptimizeReport {
  skillName: string;
  originalTriggers: string[];
  bestTriggers: string[];
  bestTestAccuracy: number | null;
  bestTrainAccuracy: number;
  iterationsRun: number;
  exitReason: string;
  history: OptimizeIteration[];
  /** Final eval of bestTriggers over the FULL case set. */
  finalReport: TriggerEvalReport;
}

/** Minimal brain surface (mirrors Brain.call structurally). */
export interface TriggerBrain {
  call(
    request: { messages: Array<{ role: string; content: string }>; source?: string },
    opts?: { tier?: string; strategy?: string },
  ): Promise<{ content?: string }>;
}

// ---------------------------------------------------------------------------
// Deterministic split (seeded LCG — Math.random is banned in eval paths)
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Stratified train/test split; same seed → same split. Each class keeps ≥1 test case when it can spare one. */
export function splitEvalSet(
  cases: readonly TriggerEvalCase[],
  holdout: number,
  seed = 42,
): { train: TriggerEvalCase[]; test: TriggerEvalCase[] } {
  if (holdout <= 0) return { train: [...cases], test: [] };
  const rand = lcg(seed);
  const pos = shuffle(cases.filter((c) => c.shouldTrigger), rand);
  const neg = shuffle(cases.filter((c) => !c.shouldTrigger), rand);
  const take = (group: TriggerEvalCase[]): number =>
    group.length < 2 ? 0 : Math.max(1, Math.floor(group.length * holdout));
  const nPos = take(pos);
  const nNeg = take(neg);
  return {
    test: [...pos.slice(0, nPos), ...neg.slice(0, nNeg)],
    train: [...pos.slice(nPos), ...neg.slice(nNeg)],
  };
}

// ---------------------------------------------------------------------------
// Evaluation (free, deterministic, uses the REAL matcher)
// ---------------------------------------------------------------------------

export function confusionMatrix(results: readonly TriggerCaseResult[]): ConfusionMatrix {
  let tp = 0; let fp = 0; let tn = 0; let fn = 0;
  for (const r of results) {
    if (r.shouldTrigger && r.triggered) tp++;
    else if (r.shouldTrigger && !r.triggered) fn++;
    else if (!r.shouldTrigger && r.triggered) fp++;
    else tn++;
  }
  const total = tp + fp + tn + fn;
  return {
    tp, fp, tn, fn,
    precision: tp + fp > 0 ? tp / (tp + fp) : 1,
    recall: tp + fn > 0 ? tp / (tp + fn) : 1,
    accuracy: total > 0 ? (tp + tn) / total : 0,
  };
}

/** Evaluate a trigger set against cases via the production matcher. */
export function runTriggerEval(
  skillName: string,
  triggers: readonly string[],
  cases: readonly TriggerEvalCase[],
): TriggerEvalReport {
  const probe: ActivatableSkill = { name: skillName, content: '', triggers: [...triggers] };
  const results: TriggerCaseResult[] = cases.map((c) => {
    const m = matchTriggers(c.query, probe);
    const triggered = m !== null;
    return { ...c, triggered, matchedPhrase: m?.phrase, pass: triggered === c.shouldTrigger };
  });
  return { skillName, triggers: [...triggers], results, matrix: confusionMatrix(results) };
}

/**
 * Async variant measuring the COMBINED activator exactly as the agent loop
 * runs it: deterministic phrase match first, semantic recall assist only on
 * misses. `semanticProbe` returns the matched anchor (or null) for a query —
 * pass a closure over skills/semantic-assist.ts selectSemanticSkill so this
 * measures the REAL production path, not a reimplementation. Semantic hits
 * carry a `~` prefix on matchedPhrase to keep the match kinds distinguishable.
 */
export async function runTriggerEvalCombined(
  skillName: string,
  triggers: readonly string[],
  cases: readonly TriggerEvalCase[],
  semanticProbe: (query: string) => Promise<{ phrase: string } | null>,
): Promise<TriggerEvalReport> {
  const probe: ActivatableSkill = { name: skillName, content: '', triggers: [...triggers] };
  const results: TriggerCaseResult[] = [];
  for (const c of cases) {
    const m = matchTriggers(c.query, probe);
    let triggered = m !== null;
    let matchedPhrase = m?.phrase;
    if (!triggered) {
      const s = await semanticProbe(c.query);
      if (s) { triggered = true; matchedPhrase = `~${s.phrase}`; }
    }
    results.push({ ...c, triggered, matchedPhrase, pass: triggered === c.shouldTrigger });
  }
  return { skillName, triggers: [...triggers], results, matrix: confusionMatrix(results) };
}

// ---------------------------------------------------------------------------
// Parsing helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Extract the first JSON array from a model reply; returns [] on failure. */
export function extractJsonArray(reply: string): unknown[] {
  try {
    const start = reply.indexOf('[');
    const end = reply.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseTriggerList(reply: string): string[] {
  return [...new Set(
    extractJsonArray(reply)
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length <= 80),
  )].slice(0, 20);
}

export function parseEvalCases(reply: string, max: number): TriggerEvalCase[] {
  const out: TriggerEvalCase[] = [];
  for (const item of extractJsonArray(reply)) {
    const o = item as { query?: unknown; should_trigger?: unknown; shouldTrigger?: unknown };
    const st = typeof o?.should_trigger === 'boolean' ? o.should_trigger
      : typeof o?.shouldTrigger === 'boolean' ? o.shouldTrigger : undefined;
    if (typeof o?.query === 'string' && o.query.trim() !== '' && st !== undefined) {
      out.push({ query: o.query.trim(), shouldTrigger: st });
    }
  }
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// Eval-set generation (one brain call; near-miss guidance)
// ---------------------------------------------------------------------------

export function buildGenPrompt(skillName: string, markdown: string, k: number): string {
  const half = Math.ceil(k / 2);
  return [
    `Write ${k} trigger-evaluation queries for the assistant skill below: ${half} that SHOULD`,
    `activate it and ${k - half} that should NOT.`,
    'Queries must read like real user messages: concrete, specific, casual where natural,',
    'with details (names, files, situations). Vary length and phrasing.',
    'The should-NOT queries must be NEAR-MISSES sharing words or concepts with the skill but',
    'genuinely needing something else — obviously-unrelated negatives test nothing.',
    'Return ONLY a JSON array: [{"query": "...", "should_trigger": true|false}, ...]',
    '',
    `--- SKILL ${skillName} ---`,
    markdown.slice(0, 5000),
  ].join('\n');
}

export async function generateTriggerEvalSet(
  skillName: string,
  markdown: string,
  brain: TriggerBrain,
  k = 12,
  tier = 'fast',
): Promise<TriggerEvalCase[]> {
  const resp = await brain.call(
    { messages: [{ role: 'user', content: buildGenPrompt(skillName, markdown, k) }], source: 'trigger-eval' },
    { tier, strategy: 'single' },
  );
  const cases = parseEvalCases(resp.content ?? '', k);
  if (cases.length < 4 || !cases.some((c) => c.shouldTrigger) || !cases.some((c) => !c.shouldTrigger)) {
    throw new Error('Could not generate a usable eval set (need both classes, ≥4 cases) — provide queries explicitly.');
  }
  log.info({ skillName, generated: cases.length }, 'trigger-eval: eval set generated');
  return cases;
}

// ---------------------------------------------------------------------------
// Optimization loop (brain proposes; deterministic matcher scores for free)
// ---------------------------------------------------------------------------

export function buildProposalPrompt(
  skillName: string,
  description: string,
  current: readonly string[],
  trainFailures: readonly TriggerCaseResult[],
  history: readonly { triggers: string[]; trainAccuracy: number }[],
): string {
  const parts = [
    `You are optimizing the TRIGGER PHRASES for the assistant skill "${skillName}".`,
    'Matching is mechanical: a phrase activates the skill when it appears as a whole-word,',
    'punctuation/case-insensitive sequence inside the user message. No semantics — only the',
    'literal phrases you choose. Short generic phrases over-trigger; long specific ones under-trigger.',
    '',
    `Skill description: ${description || '(none)'}`,
    `Current triggers: ${JSON.stringify(current)}`,
    '',
    'Failures on the training queries:',
  ];
  for (const f of trainFailures) {
    parts.push(
      f.shouldTrigger
        ? `- MISSED (should trigger, did not): "${f.query}"`
        : `- FALSE FIRE (matched "${f.matchedPhrase}", should stay quiet): "${f.query}"`,
    );
  }
  if (history.length > 0) {
    parts.push('', 'Previous attempts — do NOT repeat these sets, try something structurally different:');
    for (const h of history) {
      parts.push(`- accuracy ${(h.trainAccuracy * 100).toFixed(0)}%: ${JSON.stringify(h.triggers)}`);
    }
  }
  parts.push(
    '',
    'Generalize from the failures — cover the INTENT with a handful of phrase families rather',
    'than enumerating every failing query verbatim. 5-12 phrases, each 1-5 words.',
    'Return ONLY a JSON array of strings.',
  );
  return parts.join('\n');
}

export interface OptimizeOptions {
  skillName: string;
  description?: string;
  triggers: string[];
  cases: TriggerEvalCase[];
  brain: TriggerBrain;
  maxIterations?:
 number;
  holdout?: number;
  seed?: number;
  tier?: string;
}

/**
 * Iteratively improve a trigger set. Scoring is free (deterministic matcher);
 * only proposals cost a brain call. The proposal prompt sees train failures
 * and prior attempts' TRAIN accuracy only — never held-out results — and the
 * winner is chosen by TEST accuracy (train, when no holdout).
 */
export async function optimizeTriggers(opts: OptimizeOptions): Promise<OptimizeReport> {
  const maxIterations = Math.min(Math.max(opts.maxIterations ?? 5, 1), 10);
  const holdout = opts.holdout ?? 0.4;
  const { train, test } = splitEvalSet(opts.cases, holdout, opts.seed ?? 42);
  const history: OptimizeIteration[] = [];
  let current = [...opts.triggers];
  let exitReason = 'max_iterations';

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const trainReport = runTriggerEval(opts.skillName, current, train);
    const testReport = test.length > 0 ? runTriggerEval(opts.skillName, current, test) : null;
    const trainFailures = trainReport.results.filter((r) => !r.pass);
    history.push({
      iteration,
      triggers: [...current],
      trainAccuracy: trainReport.matrix.accuracy,
      testAccuracy: testReport ? testReport.matrix.accuracy : null,
      trainFailures,
    });
    log.info(
      { skill: opts.skillName, iteration, trainAcc: trainReport.matrix.accuracy, testAcc: testReport?.matrix.accuracy ?? null },
      'trigger-eval: iteration scored',
    );
    if (trainFailures.length === 0) { exitReason = `all_train_passed (iteration ${iteration})`; break; }
    if (iteration === maxIterations) break;

    // Test-blinded proposal: history entries carry ONLY train accuracy.
    const prompt = buildProposalPrompt(
      opts.skillName,
      opts.description ?? '',
      current,
      trainFailures,
      history.map((h) => ({ triggers: h.triggers, trainAccuracy: h.trainAccuracy })),
    );
    const resp = await opts.brain.call(
      { messages: [{ role: 'user', content: prompt }], source: 'trigger-eval' },
      { tier: opts.tier ?? 'fast', strategy: 'single' },
    );
    const proposed = parseTriggerList(resp.content ?? '');
    if (proposed.length === 0) { exitReason = `proposal_unparseable (iteration ${iteration})`; break; }
    current = proposed;
  }

  const byTest = test.length > 0;
  const best = history.reduce((a, b) => {
    const av = byTest ? (a.testAccuracy ?? 0) : a.trainAccuracy;
    const bv = byTest ? (b.testAccuracy ?? 0) : b.trainAccuracy;
    return bv > av ? b : a;
  });
  const finalReport = runTriggerEval(opts.skillName, best.triggers, opts.cases);
  return {
    skillName: opts.skillName,
    originalTriggers: [...opts.triggers],
    bestTriggers: best.triggers,
    bestTestAccuracy: best.testAccuracy,
    bestTrainAccuracy: best.trainAccuracy,
    iterationsRun: history.length,
    exitReason,
    history,
    finalReport,
  };
}
