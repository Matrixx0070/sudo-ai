/**
 * @file learning/repair-flywheel-verify.ts
 * @description The verify → adopt half of the repair flywheel (the moat).
 *
 * Given captured FAILING tool inputs and a candidate repair, this measures —
 * deterministically and offline — whether the repair would have converted those
 * failures into successes, then a gate decides adopt / reject / insufficient-data.
 *
 * SAFETY POSTURE (deliberate): this module VERIFIES and DECIDES; it does NOT apply
 * anything to the live agent. Auto-mutating the running harness is the one truly
 * dangerous action, so live apply stays behind a separate gate + canary + auto-
 * revert (not wired here). The scanner runs this in SHADOW mode — computing and
 * logging what it WOULD adopt — so the machinery is exercised safely as the
 * captured-input corpus fills.
 *
 * Two verification modes:
 *  - DETERMINISTIC (this file): repair is an input transform + a predicate → cheap,
 *    exact, provable now. Suits input-rewrite repairs.
 *  - LIVE A/B (not here): re-run the agent with vs without a guidance lesson →
 *    expensive/stochastic. Suits guidance repairs (the top clusters). Next step.
 */

/** A repair whose effect can be checked deterministically on the input alone. */
export interface DeterministicRepair {
  lessonId: string;
  tool: string;
  /** Rewrite a failing input toward a form that should pass. */
  transform: (input: Record<string, unknown>) => Record<string, unknown>;
  /** True when the input would pass the tool's precondition (no failure). */
  verify: (input: Record<string, unknown>) => boolean;
}

export interface ReplayVerifyResult {
  /** Inputs examined. */
  tried: number;
  /** Inputs that already passed verify (not genuine failures — excluded from rate). */
  alreadyOk: number;
  /** Genuine failures the repair converted to a pass. */
  recovered: number;
  /** recovered / (tried - alreadyOk), 0..100. */
  recoveryPct: number;
}

/**
 * Replay captured FAILING inputs through a deterministic repair and measure how
 * many it would convert to a pass. Pure — no side effects, no live agent.
 */
export function replayVerify(
  failingInputs: Array<Record<string, unknown>>,
  repair: DeterministicRepair,
): ReplayVerifyResult {
  let alreadyOk = 0;
  let recovered = 0;
  for (const input of failingInputs) {
    if (repair.verify(input)) { alreadyOk += 1; continue; } // not a genuine failure for this repair
    const repaired = repair.transform(input);
    if (repair.verify(repaired)) recovered += 1;
  }
  const genuine = failingInputs.length - alreadyOk;
  return {
    tried: failingInputs.length,
    alreadyOk,
    recovered,
    recoveryPct: genuine > 0 ? Math.round((1000 * recovered) / genuine) / 10 : 0,
  };
}

export type AdoptionDecision = 'adopt' | 'reject' | 'insufficient-data';

export interface AdoptionThresholds {
  /** Need at least this many genuine failures to decide (statistical floor). */
  minSamples: number;
  /** Recovery must clear this % to adopt. */
  minRecoveryPct: number;
}

export const DEFAULT_ADOPTION_THRESHOLDS: AdoptionThresholds = { minSamples: 20, minRecoveryPct: 80 };

/**
 * The adoption gate: adopt only when there's enough signal AND the repair clears
 * the recovery bar. Conservative by construction — an unproven repair is never
 * adopted; too little data defers rather than guesses.
 */
export function decideAdoption(
  r: ReplayVerifyResult,
  thresholds: AdoptionThresholds = DEFAULT_ADOPTION_THRESHOLDS,
): AdoptionDecision {
  const genuine = r.tried - r.alreadyOk;
  if (genuine < thresholds.minSamples) return 'insufficient-data';
  return r.recoveryPct >= thresholds.minRecoveryPct ? 'adopt' : 'reject';
}

import { resolve } from 'node:path';

/**
 * Deterministic repair for the read-file path cluster: rewrite an in-repo
 * absolute path to a project-relative one; `verify` = the path resolves within
 * the project root. (Post-#591 the guard accepts in-repo absolutes, so this now
 * recovers ~nothing — which is the correct signal that the bug is fixed. It stays
 * registered so a regression would be caught.)
 */
export function makeReadFilePathRepair(projectRoot: string): DeterministicRepair {
  const root = resolve(projectRoot);
  const within = (p: string): boolean => {
    const abs = p.startsWith('/') ? resolve(p) : resolve(root, p);
    return abs === root || abs.startsWith(root + '/');
  };
  return {
    lessonId: 'readfile-relative-path',
    tool: 'coder.read-file',
    verify: (input) => typeof input['path'] === 'string' && within(input['path'] as string),
    transform: (input) => {
      const p = input['path'];
      if (typeof p === 'string' && p.startsWith(root + '/')) return { ...input, path: p.slice(root.length + 1) };
      return input; // outside the repo → genuinely unreadable, not repairable
    },
  };
}

export interface ShadowDecision {
  lessonId: string;
  tool: string;
  decision: AdoptionDecision;
  result: ReplayVerifyResult;
}

/**
 * SHADOW verification: for each repair, replay-verify the captured failing inputs
 * for its tool and decide adopt/reject/insufficient. Returns decisions to LOG —
 * it never applies anything. Pure/testable; the scanner supplies real rows.
 */
export function runShadowVerification(
  failingRows: Array<{ tool_name: string; args_raw?: string | null }>,
  repairs: DeterministicRepair[],
  thresholds: AdoptionThresholds = DEFAULT_ADOPTION_THRESHOLDS,
): ShadowDecision[] {
  const out: ShadowDecision[] = [];
  for (const repair of repairs) {
    const inputs: Array<Record<string, unknown>> = [];
    for (const row of failingRows) {
      if (row.tool_name !== repair.tool || !row.args_raw) continue;
      try {
        const parsed = JSON.parse(row.args_raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) inputs.push(parsed as Record<string, unknown>);
      } catch { /* unparseable captured args — skip */ }
    }
    const result = replayVerify(inputs, repair);
    out.push({ lessonId: repair.lessonId, tool: repair.tool, decision: decideAdoption(result, thresholds), result });
  }
  return out;
}
