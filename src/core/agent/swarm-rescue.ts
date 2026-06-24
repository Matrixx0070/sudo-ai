/**
 * @file swarm-rescue.ts
 * @description Mythos Tier C — swarm-rescue: a model-agnostic, task-signal-driven
 * amplifier. When the agent loop detects that the CURRENT APPROACH is failing
 * (a repeated identical tool-error stuck signal), it escalates subsequent brain
 * calls in that turn to a stronger multi-model strategy (debate by default) to
 * break out of the rut.
 *
 * Design constraints (deliberate):
 *   - Fires on a TASK SIGNAL (stuck / repeated failure), NEVER on model identity.
 *     There is no "weak model" path — any backing LLM benefits identically.
 *     (See the #426 revert: the harness must be uniform/model-agnostic.)
 *   - Reuses the EXISTING Brain strategy machinery (BrainCallOpts.strategy →
 *     runDebate / runTreeSearch). No new brain, no new model calls outside the
 *     established strategy router.
 *   - Opt-in and default-OFF (`SUDO_SWARM_RESCUE`). With it unset, the loop is
 *     byte-for-byte unchanged.
 *
 * The default strategy is `debate`: its Blue→Red→Revise rounds keep full tool
 * access on the proposer/reviser rounds (so the agentic tool-loop still works)
 * and it needs no verifier — a good fit for "you keep hitting the same error,
 * critique the approach and revise." `tree-search` is also accepted for callers
 * that supply a verifier.
 */

import type { BrainStrategy } from '../brain/brain-strategy.js';

/** Strategies a rescue may escalate to. `single` is excluded — it is the
 *  baseline that got stuck, so escalating to it would be a no-op. */
const RESCUE_STRATEGIES: ReadonlySet<string> = new Set<BrainStrategy>(['debate', 'tree-search']);

/** Default rescue strategy: tool-loop-safe and verifier-free. */
export const DEFAULT_SWARM_RESCUE_STRATEGY: BrainStrategy = 'debate';

/** Whether swarm-rescue is enabled. Default OFF (opt-in via SUDO_SWARM_RESCUE=1). */
export function isSwarmRescueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_SWARM_RESCUE'] === '1';
}

/**
 * The strategy a rescue escalates to. Reads `SUDO_SWARM_RESCUE_STRATEGY`
 * (case-insensitive); falls back to the default for unset/invalid values
 * (notably `single`, which would be a no-op).
 */
export function getSwarmRescueStrategy(env: NodeJS.ProcessEnv = process.env): BrainStrategy {
  const raw = env['SUDO_SWARM_RESCUE_STRATEGY']?.toLowerCase().trim();
  if (raw && RESCUE_STRATEGIES.has(raw)) return raw as BrainStrategy;
  return DEFAULT_SWARM_RESCUE_STRATEGY;
}

/**
 * BrainCallOpts to pass on a brain call while a rescue is active, or `undefined`
 * when it isn't (preserving the exact prior call shape). Kept tiny and pure so
 * the loop wiring stays a one-liner and the decision is unit-testable.
 */
export function swarmRescueCallOpts(
  active: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { strategy: BrainStrategy } | undefined {
  return active ? { strategy: getSwarmRescueStrategy(env) } : undefined;
}
