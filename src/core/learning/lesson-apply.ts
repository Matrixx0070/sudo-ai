/**
 * @file learning/lesson-apply.ts
 * @description The APPLY half of the flywheel — the one genuinely dangerous step,
 * wrapped so it can never do harm: gated OFF by default, advisory-text only, and
 * auto-reverting on any non-improvement.
 *
 * Two responsibilities:
 *  1. getAppliedLessonHints() — what the live system prompt injects RIGHT NOW.
 *     Gated by SUDO_FLYWHEEL_APPLY (default off → [], with NO disk read). When on,
 *     returns the advisory hints of canary/promoted lessons, cached briefly so the
 *     hot prompt-assembly path never hammers the disk.
 *  2. advanceLessonLifecycle() — the canary controller. Promotes a lesson ONLY when
 *     the REAL target-metric failure rate dropped by a margin over the canary
 *     window; otherwise it REVERTS. Pure given an injected metric measurer, so the
 *     decision is fully testable and the driver (the scanner) just supplies traces.
 *
 * F86 — closing the loop SAFELY. Promotion to APPLIED status is memory surgery, so
 * combined-invariant 9 requires TWO readers to agree: reader 1 is this module's own
 * canary verification (the measured failure-rate drop); reader 2 is an INDEPENDENT
 * judge-route LLM read (invariant 7). The live driver `runLessonApplyConsensus`
 * HOLDS every promotion until both agree, caps promotions per day + budgets the
 * reader calls (invariant 10), and audits every decision (see lesson-consensus.ts).
 * Disagreement / no-independent-judge / cap / budget → ESCALATE, never execute.
 * `advanceLessonLifecycle(..., holdPromotions=true)` performs the safe transitions
 * (start-canary / revert / wait — all allowed solo) but merely PROPOSES promotions.
 *
 * SAFETY ENVELOPE (why auto-apply is acceptable here):
 *  - Default OFF. With the flag unset, the daemon's prompt is byte-identical.
 *  - Injects ADVISORY TEXT only — never changes code, never removes a feature.
 *  - Reversible: reverting drops the hint on the next prompt assembly.
 *  - A lesson only ever reaches here after an 'adopt' live-A/B decision (≥20
 *    samples / ≥80% recovery), which the corpus cannot currently satisfy — so even
 *    with the flag ON nothing applies until a lesson genuinely proves out.
 *  - Bias to safety: on ANY doubt (baseline no failures, not enough improvement,
 *    regression, reader disagreement, no independent judge) the gate REVERTS or
 *    ESCALATES, never promotes.
 */
import path from 'node:path';
import { DATA_DIR } from '../shared/paths.js';
import {
  loadLessonStore,
  saveLessonStore,
  startCanary,
  resolveCanary,
  activeLessonHints,
  type LessonStore,
  type RateSample,
} from './lesson-store.js';
import {
  type SecondReader,
  type ApplyGovernance,
  type PromotionCandidate,
  type RunBudgetState,
  applyGovernanceFromEnv,
  budgetAllows,
  consensusOutcome,
  countPromotionsToday,
  appendApplyAudit,
  lessonHash,
  storeHashOf,
} from './lesson-consensus.js';

/** Default sample guard: don't judge a canary on fewer than this many tool calls. */
export const DEFAULT_MIN_CANARY_CALLS = 20;
/** Default hard stop: if the sample guard is never met, revert at this age (7 days). */
export const DEFAULT_MAX_CANARY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** True only when the operator has explicitly opted into live apply. */
export function isApplyEnabled(): boolean {
  return process.env['SUDO_FLYWHEEL_APPLY'] === '1';
}

export function lessonStorePath(): string {
  return path.join(DATA_DIR, 'flywheel-lessons.json');
}

// --- cached hint read (hot path) --------------------------------------------
let hintCache: { at: number; hints: string[] } | null = null;
const HINT_CACHE_MS = 30_000;

/**
 * Advisory hints to inject into the live system prompt right now. Returns [] with NO
 * disk read when apply is disabled — so the default path is free. `nowMs` is injected
 * for testability (defaults to Date.now()).
 */
export function getAppliedLessonHints(nowMs: number = Date.now()): string[] {
  if (!isApplyEnabled()) return [];
  if (hintCache && nowMs - hintCache.at < HINT_CACHE_MS) return hintCache.hints;
  let hints: string[] = [];
  try {
    hints = activeLessonHints(loadLessonStore(lessonStorePath()));
  } catch {
    hints = [];
  }
  hintCache = { at: nowMs, hints };
  return hints;
}

/** Drop the hint cache (call after mutating the store so the next prompt reflects it). */
export function invalidateHintCache(): void {
  hintCache = null;
}

// --- canary verdict (pure) --------------------------------------------------

export interface CanaryVerdictOpts {
  /** Fractional drop in failure rate required to promote (default 0.2 = 20% lower). */
  minImprovement: number;
}

export const DEFAULT_CANARY_OPTS: CanaryVerdictOpts = { minImprovement: 0.2 };

/**
 * Judge a canary from its baseline vs measured failure rate. Promote ONLY on a clear
 * improvement; revert on no-improvement, regression, or nothing to gain (baseline 0).
 * Pure.
 */
export function canaryVerdict(baseline: number, canary: number, opts: CanaryVerdictOpts = DEFAULT_CANARY_OPTS): { promote: boolean; reason: string } {
  if (baseline <= 0) return { promote: false, reason: 'no baseline failures to improve — nothing to gain' };
  if (canary > baseline) return { promote: false, reason: `regression: failure rate rose ${baseline.toFixed(3)}→${canary.toFixed(3)}` };
  const improved = canary <= baseline * (1 - opts.minImprovement);
  return improved
    ? { promote: true, reason: `failure rate dropped ${baseline.toFixed(3)}→${canary.toFixed(3)} (≥${Math.round(opts.minImprovement * 100)}%)` }
    : { promote: false, reason: `improvement below ${Math.round(opts.minImprovement * 100)}% bar (${baseline.toFixed(3)}→${canary.toFixed(3)})` };
}

// --- lifecycle driver (pure given injected measurer) ------------------------

export interface LifecycleDeps {
  /**
   * Target-CLUSTER failure rate + sample size for a tool over [sinceISO, now]
   * (whole-corpus if sinceISO omitted). `errorPattern` narrows the numerator to the
   * lesson's specific failure cluster; the denominator is the tool's total calls, so
   * `calls` also drives the min-sample guard.
   */
  measureClusterRate: (tool: string, errorPattern?: string, sinceISO?: string) => RateSample;
  nowMs: number;
  nowISO: string;
}

export interface LifecycleAction {
  lessonId: string;
  action: 'started-canary' | 'promoted' | 'reverted' | 'waiting' | 'propose-promote' | 'escalated';
  reason: string;
  /**
   * Present ONLY on a 'propose-promote' action (hold mode): the measured numbers the
   * two-reader consensus gate + audit ledger need to judge the promotion.
   */
  candidate?: {
    tool: string;
    hint: string;
    baselineFailRate: number;
    canaryFailRate: number;
    canaryCalls: number;
    authorRoute?: string;
  };
}

/**
 * Advance every lesson one lifecycle step from real measurements. Candidates start a
 * canary (recording the baseline); canaries past their window are judged and
 * promoted/reverted. Returns the new store, whether anything changed, and the actions
 * taken (for logging). Pure — no I/O; the caller persists and logs.
 *
 * When `holdPromotions` is true (the F86 live path), a would-promote canary is NOT
 * mutated to `promoted` — it emits a 'propose-promote' action (carrying the measured
 * numbers) and stays in `canary`, so the two-reader consensus gate can decide. Safe
 * transitions (start-canary, revert, wait) always apply — they are not memory surgery.
 */
export function advanceLessonLifecycle(store: LessonStore, deps: LifecycleDeps, opts: CanaryVerdictOpts = DEFAULT_CANARY_OPTS, holdPromotions = false): { store: LessonStore; changed: boolean; actions: LifecycleAction[] } {
  let next = store;
  const actions: LifecycleAction[] = [];

  for (const lesson of store.lessons) {
    if (lesson.state === 'candidate') {
      const baseline = deps.measureClusterRate(lesson.tool, lesson.errorPattern);
      next = startCanary(next, lesson.lessonId, baseline, deps.nowISO);
      actions.push({ lessonId: lesson.lessonId, action: 'started-canary', reason: `baseline rate=${baseline.rate.toFixed(3)} over ${baseline.calls} calls` });
      continue;
    }
    if (lesson.state === 'canary' && lesson.canaryStartedAt) {
      const elapsed = deps.nowMs - Date.parse(lesson.canaryStartedAt);
      if (elapsed < lesson.canaryWindowMs) continue; // window not up yet
      const canary = deps.measureClusterRate(lesson.tool, lesson.errorPattern, lesson.canaryStartedAt);
      const minCalls = lesson.minCanaryCalls ?? DEFAULT_MIN_CANARY_CALLS;
      const maxWindow = lesson.maxCanaryWindowMs ?? DEFAULT_MAX_CANARY_WINDOW_MS;

      // Sample guard: don't judge on thin canary traffic. Keep waiting until the
      // hard stop, then revert (an unverifiable lesson must not linger applied).
      if (canary.calls < minCalls) {
        if (elapsed >= maxWindow) {
          next = resolveCanary(next, lesson.lessonId, canary, false, deps.nowISO, `insufficient canary traffic (${canary.calls}<${minCalls}) by max window — reverting unverified`);
          actions.push({ lessonId: lesson.lessonId, action: 'reverted', reason: `unverifiable: only ${canary.calls} calls in window` });
        } else {
          actions.push({ lessonId: lesson.lessonId, action: 'waiting', reason: `canary traffic ${canary.calls}<${minCalls} — waiting for samples` });
        }
        continue;
      }

      const v = canaryVerdict(lesson.baselineFailRate ?? 0, canary.rate, opts);
      if (v.promote && holdPromotions) {
        // F86: promotion is memory surgery — do NOT mutate. Propose it; the consensus
        // gate (reader 2 + cap + budget) decides. Lesson stays in `canary`.
        actions.push({
          lessonId: lesson.lessonId,
          action: 'propose-promote',
          reason: v.reason,
          candidate: {
            tool: lesson.tool,
            hint: lesson.hint,
            baselineFailRate: lesson.baselineFailRate ?? 0,
            canaryFailRate: canary.rate,
            canaryCalls: canary.calls,
            authorRoute: lesson.authorRoute,
          },
        });
        continue;
      }
      next = resolveCanary(next, lesson.lessonId, canary, v.promote, deps.nowISO, v.reason);
      actions.push({ lessonId: lesson.lessonId, action: v.promote ? 'promoted' : 'reverted', reason: `${v.reason} over ${canary.calls} calls` });
    }
  }
  // 'waiting'/'propose-promote' are informational, not store mutations — only real transitions persist.
  const mutated = actions.some((a) => a.action !== 'waiting' && a.action !== 'propose-promote');
  return { store: next, changed: mutated, actions };
}

/**
 * Full driver step used by the scanner (when apply is enabled): load → advance →
 * persist → invalidate cache. Fail-open. No-op (returns []) when apply is disabled.
 *
 * NOTE: this legacy synchronous driver promotes on the OWN canary verdict alone (no
 * second reader). It is retained for the pure unit tests only; the LIVE path is the
 * consensus-gated `runLessonApplyConsensus`, which the scanner uses. Do NOT wire this
 * into any real mutation path — invariant 9 requires two readers for a promotion.
 */
export function runLessonLifecycle(deps: LifecycleDeps, opts: CanaryVerdictOpts = DEFAULT_CANARY_OPTS): LifecycleAction[] {
  if (!isApplyEnabled()) return [];
  try {
    const store = loadLessonStore(lessonStorePath());
    const { store: next, changed, actions } = advanceLessonLifecycle(store, deps, opts);
    if (changed) {
      saveLessonStore(lessonStorePath(), next);
      invalidateHintCache();
    }
    return actions;
  } catch {
    return [];
  }
}

/**
 * F86 LIVE DRIVER — consensus-gated, capped, audited lesson apply.
 *
 * 1. Apply the SAFE transitions (start-canary / revert / wait) via holdPromotions;
 *    persist them (they are not memory surgery — allowed solo per invariant 9).
 * 2. For each PROPOSED promotion (reader 1 = own canary verification already says
 *    promote): enforce the daily cap, then the fail-closed per-run budget, then call
 *    the INDEPENDENT second reader. Promote ONLY on two-reader agreement; otherwise
 *    ESCALATE (leave in canary, never execute). Audit every outcome.
 *
 * No-op (returns []) when apply is disabled → today's exact byte-identical behavior.
 * Fail-open on any unexpected error. Async because reader 2 is an LLM call.
 */
export async function runLessonApplyConsensus(
  deps: LifecycleDeps,
  reader: SecondReader,
  gov: ApplyGovernance = applyGovernanceFromEnv(),
  opts: CanaryVerdictOpts = DEFAULT_CANARY_OPTS,
): Promise<LifecycleAction[]> {
  if (!isApplyEnabled()) return [];
  try {
    let store = loadLessonStore(lessonStorePath());
    const { store: afterSafe, changed: safeChanged, actions } = advanceLessonLifecycle(store, deps, opts, true);
    store = afterSafe;
    let dirty = safeChanged;

    const out: LifecycleAction[] = [];
    // Audit + surface the safe transitions.
    for (const a of actions) {
      if (a.action === 'propose-promote') continue;
      out.push(a);
      if (a.action === 'started-canary' || a.action === 'reverted') {
        appendApplyAudit({
          ts: deps.nowISO,
          event: a.action,
          lessonId: a.lessonId,
          tool: '',
          reader1: { promote: false, reason: a.reason },
          lessonHash: lessonHash({ lessonId: a.lessonId, tool: '', hint: '' }),
          storeHash: storeHashOf(store),
        });
      }
    }

    const proposals = actions.filter((a) => a.action === 'propose-promote');
    if (proposals.length > 0) {
      let promotedToday = countPromotionsToday(deps.nowISO);
      const budget: RunBudgetState = { spentUsd: 0, spentTokens: 0 };
      const storeHash = storeHashOf(store);

      for (const a of proposals) {
        const c = a.candidate!;
        const cand: PromotionCandidate = {
          lessonId: a.lessonId,
          tool: c.tool,
          hint: c.hint,
          baselineFailRate: c.baselineFailRate,
          canaryFailRate: c.canaryFailRate,
          canaryCalls: c.canaryCalls,
          authorRoute: c.authorRoute,
        };
        const reader1 = { promote: true, reason: a.reason };
        const lHash = lessonHash(cand);

        // Daily cap (invariant 10). Refuse — never execute.
        if (promotedToday >= gov.dailyCap) {
          appendApplyAudit({ ts: deps.nowISO, event: 'refused-cap', lessonId: a.lessonId, tool: c.tool, reader1, lessonHash: lHash, storeHash, authorRoute: c.authorRoute });
          out.push({ lessonId: a.lessonId, action: 'waiting', reason: `daily apply cap reached (${gov.dailyCap}) — promotion deferred` });
          continue;
        }
        // Per-run budget, fail-closed pre-check (invariant 10).
        if (!budgetAllows(budget, gov)) {
          appendApplyAudit({ ts: deps.nowISO, event: 'refused-budget', lessonId: a.lessonId, tool: c.tool, reader1, lessonHash: lHash, storeHash, authorRoute: c.authorRoute });
          out.push({ lessonId: a.lessonId, action: 'waiting', reason: 'per-run consensus budget exhausted — promotion deferred (fail-closed)' });
          continue;
        }

        // Reader 2 — the independent judge read.
        let r2;
        try {
          r2 = await reader(cand);
        } catch (e) {
          r2 = { available: false as const, reason: `reader threw: ${String(e)}` };
        }
        if (r2.available) {
          budget.spentUsd += r2.usdUsed;
          budget.spentTokens += r2.tokensUsed;
        }
        const reader2Audit = r2.available
          ? { available: true, agree: r2.agree, reason: r2.reason, judgeRoute: r2.judgeRoute }
          : { available: false, reason: r2.reason };

        if (consensusOutcome(r2) === 'promote') {
          store = resolveCanary(store, a.lessonId, { rate: c.canaryFailRate, calls: c.canaryCalls }, true, deps.nowISO, `two-reader consensus: ${reader1.reason} | judge(${r2.available ? r2.judgeRoute : '-'})`);
          dirty = true;
          promotedToday += 1;
          appendApplyAudit({ ts: deps.nowISO, event: 'promoted', lessonId: a.lessonId, tool: c.tool, reader1, reader2: reader2Audit, lessonHash: lHash, storeHash, authorRoute: c.authorRoute });
          out.push({ lessonId: a.lessonId, action: 'promoted', reason: 'two-reader consensus agreed — promoted' });
        } else {
          appendApplyAudit({ ts: deps.nowISO, event: 'escalated', lessonId: a.lessonId, tool: c.tool, reader1, reader2: reader2Audit, lessonHash: lHash, storeHash, authorRoute: c.authorRoute });
          out.push({ lessonId: a.lessonId, action: 'escalated', reason: r2.available ? 'independent reader DISAGREED — escalated for human review, not promoted' : `no independent reader (${r2.reason}) — escalated, not promoted` });
        }
      }
    }

    if (dirty) {
      saveLessonStore(lessonStorePath(), store);
      invalidateHintCache();
    }
    return out;
  } catch {
    return [];
  }
}
