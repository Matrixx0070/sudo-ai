/**
 * @file self-improvement/pipeline-manifest.ts
 * @description AL9.1 — the AL8 improvement pipeline's configuration as ONE
 * versioned, reviewable artifact. The running pipeline pins exactly one
 * manifest version; changing the manifest is a PR like any other (this file
 * IS the manifest — semver bumped in review, diffable, revertable: a manifest
 * revert is a full pipeline-policy rollback, which is the AL9 rollback story).
 *
 * AL9.5 independence rule rides the version pin: every proposal is stamped
 * with the manifest version ACTIVE AT PROPOSAL TIME, and its validation bars
 * are read from that pinned manifest — a later manifest change (e.g. a new
 * validator threshold) applies only to proposals made AFTER the change.
 * Generation N+1's validators can never be swapped under generation N's
 * in-flight artifacts, and no artifact is graded by rules it authored.
 *
 * Everything AL9 ships flag-OFF: SUDO_AL_META=1 enables meta-proposals
 * (pipeline-change artifacts); default OFF refuses them fail-closed (AL9.6).
 */

export interface PipelineManifest {
  /** Semver. Meta-proposals must target a STRICT increase. */
  version: string;
  /** ISO date this manifest version was authored. */
  authoredAt: string;
  generator: {
    /** Version tag of the learnings-draft generator behavior. */
    learningsDraftVersion: string;
  };
  validators: {
    /** promptPlugin size bound. */
    maxPromptChars: number;
    /** promptPlugin requires an injection scan (fail-closed without one). */
    requireInjectionScan: boolean;
    /** codePatchPlugin requires a trust-tier sandbox validator. */
    requireSandboxForCode: boolean;
  };
  evalSuite: {
    /** Bench suites the bench stage is expected to run against. */
    suites: string[];
  };
  adoption: {
    /** Minimum held-out pass rate a proposal needs at the bench stage. */
    minPassRate: number;
    /** Sanctioned per-day proposal budget (invariant 10). */
    proposalsPerDay: number;
  };
}

/**
 * v1.0.0 — a pure EXTRACTION of the AL8 pipeline's behavior as merged in
 * PRs #959/#961: same bounds, same fail-closed requirements, no behavior
 * change (pinned by the existing AL8 regression tests).
 */
export const CURRENT_MANIFEST: PipelineManifest = {
  version: '1.0.0',
  authoredAt: '2026-07-28',
  generator: { learningsDraftVersion: 'learnings-v1' },
  validators: {
    maxPromptChars: 20_000,
    requireInjectionScan: true,
    requireSandboxForCode: true,
  },
  evalSuite: { suites: ['agent-tasks', 'builtin-tasks'] },
  // minPassRate 0 = no additional bar beyond the gate's own verdict — that IS
  // current behavior (pure extraction); raising it is a future manifest bump.
  adoption: { minPassRate: 0, proposalsPerDay: 10 },
};

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(v: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `candidate` is a strictly higher semver than `base`. */
export function isVersionIncrease(base: string, candidate: string): boolean {
  const a = parseSemver(base);
  const b = parseSemver(candidate);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i]! > a[i]!) return true;
    if (b[i]! < a[i]!) return false;
  }
  return false;
}

/** Fail-loud structural validation (AL2.3 rule) for any manifest object. */
export function validateManifest(m: PipelineManifest): void {
  if (!parseSemver(m.version)) throw new Error(`manifest version "${m.version}" is not semver`);
  if (!Number.isInteger(m.validators.maxPromptChars) || m.validators.maxPromptChars < 100) {
    throw new Error(`manifest maxPromptChars must be an integer ≥ 100 (got ${m.validators.maxPromptChars})`);
  }
  if (typeof m.adoption.minPassRate !== 'number' || m.adoption.minPassRate < 0 || m.adoption.minPassRate > 1) {
    throw new Error(`manifest minPassRate must be 0..1 (got ${m.adoption.minPassRate})`);
  }
  if (!Number.isInteger(m.adoption.proposalsPerDay) || m.adoption.proposalsPerDay < 1) {
    throw new Error(`manifest proposalsPerDay must be an integer ≥ 1`);
  }
  if (!Array.isArray(m.evalSuite.suites) || m.evalSuite.suites.length === 0) {
    throw new Error('manifest evalSuite.suites must be non-empty');
  }
}

/**
 * AL9.4 never-weaken rule, machine-side: a MACHINE-PROPOSED manifest change
 * may tighten bars and grow the eval suite, never the reverse. Weakening
 * (lower pass bar, higher budgets, dropped suites, looser validators) is a
 * HUMAN-AUTHORED PR only — the meta path refuses it structurally.
 * Returns the list of weakenings found (empty = acceptable).
 */
export function findWeakenings(base: PipelineManifest, candidate: PipelineManifest): string[] {
  const w: string[] = [];
  if (candidate.adoption.minPassRate < base.adoption.minPassRate) {
    w.push(`minPassRate lowered ${base.adoption.minPassRate} → ${candidate.adoption.minPassRate}`);
  }
  if (candidate.adoption.proposalsPerDay > base.adoption.proposalsPerDay) {
    w.push(`proposalsPerDay raised ${base.adoption.proposalsPerDay} → ${candidate.adoption.proposalsPerDay}`);
  }
  if (base.validators.requireInjectionScan && !candidate.validators.requireInjectionScan) {
    w.push('requireInjectionScan disabled');
  }
  if (base.validators.requireSandboxForCode && !candidate.validators.requireSandboxForCode) {
    w.push('requireSandboxForCode disabled');
  }
  const dropped = base.evalSuite.suites.filter((s) => !candidate.evalSuite.suites.includes(s));
  if (dropped.length > 0) w.push(`eval suites removed: ${dropped.join(', ')}`);
  if (candidate.validators.maxPromptChars > base.validators.maxPromptChars * 2) {
    w.push(`maxPromptChars more than doubled (${base.validators.maxPromptChars} → ${candidate.validators.maxPromptChars})`);
  }
  return w;
}
