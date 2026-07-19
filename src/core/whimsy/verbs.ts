/**
 * @file whimsy/verbs.ts
 * @description BO11 / scorecard-S14 — whimsy pools + gate.
 *
 * OpenClaw sprinkles personality into its live states ("noodling…",
 * "dillydallying…") and its startup banner ("I'm basically a Swiss Army knife,
 * but with more opinions and fewer sharp edges."). This module is our pool of
 * that flavor, plus a lightweight first-run "birth ritual" acknowledgement.
 *
 * HARD RULES (see CLAUDE.md invariant 4 + BO11 brief):
 *   - Everything here is OFF by default. {@link whimsyEnabled} gates on the
 *     `SUDO_WHIMSY=1` env flag; when unset, every gated helper returns '' / null
 *     so prod tone is byte-for-byte unchanged until an operator opts in.
 *   - Deterministic & testable: rotation takes an INJECTED index (never an
 *     internal RNG/clock), so a test pins the exact output.
 *   - The birth ritual writes NOTHING to frozen identity surfaces. It only
 *     returns copy for non-frozen channels/prompts; callers persist a first-run
 *     marker outside PROTECTED_PATHS if they want one.
 */

/** Rotating working verbs shown in the "waiting" phase of a live turn. */
export const WORKING_VERBS: readonly string[] = [
  'noodling',
  'dillydallying',
  'pondering',
  'tinkering',
  'cogitating',
  'ruminating',
  'percolating',
  'marinating',
  'puttering',
  'woolgathering',
  'mulling',
  'scheming',
];

/** Rotating startup / idle taglines shown in the banner. */
export const TAGLINES: readonly string[] = [
  "I'm basically a Swiss Army knife, but with more opinions and fewer sharp edges.",
  'Autonomous, caffeinated, and suspiciously eager to help.',
  'Two hundred tools and the restraint to (usually) pick the right one.',
  'I remember things. Mostly the useful ones.',
  'Part shell, part daemon, all business.',
  'Here to turn your vague hunches into shipped commits.',
  'I read the docs so you do not have to. (You still should.)',
  'Low latency, high opinions.',
];

/**
 * First-run "birth ritual" prompt copy — surfaced to a NON-frozen channel/prompt
 * on the agent's very first conversation. Deliberately does not name the agent
 * or write identity files; it invites the operator to do the naming together.
 */
export const BIRTH_RITUAL_PROMPT =
  "First boot — nice to meet you. I don't have a name or a vibe yet. Want to pick " +
  'one together? Tell me a name, a creature, and a one-word mood, and I will carry ' +
  'them from here. (You can also just say "skip" and we get straight to work.)';

/** True only when the operator has opted into whimsy via `SUDO_WHIMSY=1`. */
export function whimsyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_WHIMSY'] === '1';
}

/**
 * Deterministic, wrap-around pick from a pool by index. Negative and
 * out-of-range indices are normalized. Empty pool → ''.
 */
export function pickFrom(pool: readonly string[], index: number): string {
  if (pool.length === 0) return '';
  const i = Math.trunc(Number.isFinite(index) ? index : 0);
  const wrapped = ((i % pool.length) + pool.length) % pool.length;
  return pool[wrapped] ?? '';
}

/** Options for the gated helpers — `enabled` overrides the env gate (tests). */
export interface WhimsyOptions {
  /** Force on/off, bypassing the env gate. */
  enabled?: boolean;
}

function resolveEnabled(opts?: WhimsyOptions): boolean {
  return opts?.enabled ?? whimsyEnabled();
}

/**
 * The working verb for a given rotation index, or '' when whimsy is off.
 * `index` is injected by the caller (e.g. a per-turn tick) so it is fully
 * deterministic.
 */
export function workingVerb(index: number, opts?: WhimsyOptions): string {
  if (!resolveEnabled(opts)) return '';
  return pickFrom(WORKING_VERBS, index);
}

/** The startup/idle tagline for a rotation index, or '' when whimsy is off. */
export function startupTagline(index: number, opts?: WhimsyOptions): string {
  if (!resolveEnabled(opts)) return '';
  return pickFrom(TAGLINES, index);
}

/**
 * Birth-ritual acknowledgement copy for the agent's first run, or null when
 * whimsy is off or this is not the first run. PURE — the caller decides how it
 * detects "first run" (a non-frozen marker file) and passes {@link isFirstRun}.
 * Never returns identity-surface writes; the returned string is display copy only.
 */
export function birthRitualAck(isFirstRun: boolean, opts?: WhimsyOptions): string | null {
  if (!resolveEnabled(opts)) return null;
  if (!isFirstRun) return null;
  return BIRTH_RITUAL_PROMPT;
}
