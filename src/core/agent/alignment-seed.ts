/**
 * @file agent/alignment-seed.ts
 * @description F108 (docs/CORE_ROADMAP.md Wave D) — boot-time alignment seeding.
 *
 * The AlignmentAggregator starts with `getLastReport() === null` until the first
 * live agent turn calls `evaluate()`. Downstream governance gates — notably the
 * self-build orchestrator's `SUDO_SELF_BUILD_MIN_ALIGN_SCORE` gate — read
 * `getLastReport()` to decide whether alignment is healthy enough to proceed.
 * With no seed, that gate is perpetually stuck in a "warming-up" state and the
 * min-align-score threshold means nothing.
 *
 * Seeding fixes this: at boot we derive a baseline signal set from the operator
 * identity anchor (core-identity.md / values.json / hard-prohibitions.yaml,
 * READ-ONLY — never written) and run a single `evaluate()` so the aggregator
 * holds a real, evaluable score from the first tick onward.
 *
 * Invariant 4 (frozen surfaces): seeding only READS the identity files via the
 * pure transport loader; it never mutates them. When the anchor is absent
 * (frozen surfaces missing — an anomalous posture) the baseline is deliberately
 * degraded so the gate fails closed rather than green-lighting self-modification
 * with no identity anchor present.
 */

import { createLogger } from '../shared/logger.js';
import { projectPath } from '../shared/paths.js';
import { createIdentityLoader } from '../identity/loader.js';
import type { IdentityAnchor } from '../identity/types.js';
import type { AlignmentSignals } from './alignment-aggregator.js';

const log = createLogger('agent:alignment-seed');

/**
 * Minimal aggregator contract the seeder depends on — keeps this module
 * decoupled from the concrete AlignmentAggregator (which is a frozen
 * PROTECTED_PATH and must not be edited to add a bespoke seed method).
 */
export interface SeedableAggregator {
  evaluate(signals: AlignmentSignals): { score: number; level: string };
  getLastReport(): unknown | null;
}

/**
 * Baseline signals when the identity anchor is present and intact.
 * Maps to ~0.86 (GREEN) under the aggregator's current weights — a healthy
 * on-boot posture grounded in the presence of the operator identity anchor.
 * Real agent turns overwrite this within the first interaction.
 */
export const HEALTHY_SEED: Readonly<AlignmentSignals> = {
  outcomeDelta: 0,
  commitmentDrift: 0,
  trustTier: 1,
  injectionRate: 0,
  recoveryPending: 0,
  reAnchor: 0,
  discordanceScore: 0,
};

/**
 * Baseline signals when the identity anchor is ABSENT (all three frozen
 * surfaces missing/invalid). Maps to ~0.51 (YELLOW, below the default 0.6
 * min-align threshold) so governance gates fail closed: an agent with no
 * identity anchor should not self-modify.
 */
export const DEGRADED_SEED: Readonly<AlignmentSignals> = {
  outcomeDelta: -0.4,
  commitmentDrift: 0.6,
  trustTier: 0.3,
  injectionRate: 0.2,
  recoveryPending: 0.4,
  reAnchor: 0,
  discordanceScore: 0.3,
};

/** True when at least one identity-anchor surface resolved to real content. */
export function anchorPresent(anchor: IdentityAnchor | null): boolean {
  return (
    anchor !== null &&
    (anchor.identity !== null || anchor.values !== null || anchor.prohibitions !== null)
  );
}

/**
 * Derive the baseline seed signals from an identity anchor.
 * Pure — no I/O. Present anchor → HEALTHY_SEED; absent → DEGRADED_SEED.
 */
export function deriveSeedSignals(anchor: IdentityAnchor | null): AlignmentSignals {
  return { ...(anchorPresent(anchor) ? HEALTHY_SEED : DEGRADED_SEED) };
}

/** Directory holding the operator identity files. Env-overridable for tests. */
export function resolveIdentityDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['SUDO_IDENTITY_DIR'] ?? projectPath('config');
}

export interface SeedOutcome {
  seeded: boolean;
  anchorPresent: boolean;
  score: number | null;
  level: string | null;
}

/**
 * Seed an aggregator at boot from the operator identity anchor (READ-ONLY).
 * Never throws — on any error the aggregator is simply left in its warming-up
 * state (getLastReport() === null), which the gates treat as fail-safe.
 *
 * @param agg   The aggregator to seed (AgentLoop's AlignmentAggregator).
 * @param opts  Optional configDir / env overrides (for tests).
 */
export function seedAlignmentAggregator(
  agg: SeedableAggregator | null | undefined,
  opts: { configDir?: string; env?: NodeJS.ProcessEnv } = {},
): SeedOutcome {
  const result: SeedOutcome = { seeded: false, anchorPresent: false, score: null, level: null };
  if (!agg) return result;

  try {
    const configDir = opts.configDir ?? resolveIdentityDir(opts.env);
    let anchor: IdentityAnchor | null = null;
    try {
      anchor = createIdentityLoader(configDir).anchor;
    } catch (err) {
      // Identity load failure is non-fatal — degrade to the conservative seed.
      log.warn({ err: String(err), configDir }, 'alignment-seed: identity load failed — using degraded baseline');
    }

    const present = anchorPresent(anchor);
    const signals = deriveSeedSignals(anchor);
    const evaluated = agg.evaluate(signals);

    result.seeded = true;
    result.anchorPresent = present;
    result.score = evaluated.score;
    result.level = evaluated.level;

    log.info(
      { anchorPresent: present, score: Number(evaluated.score.toFixed(3)), level: evaluated.level },
      'AlignmentAggregator seeded at boot — SUDO_SELF_BUILD_MIN_ALIGN_SCORE now evaluable',
    );
  } catch (err) {
    log.warn({ err: String(err) }, 'alignment-seed: seeding failed — aggregator left in warming-up state');
  }

  return result;
}
