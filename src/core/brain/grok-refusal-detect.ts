/**
 * grok-refusal-detect.ts — Detects Grok identity-lock refusals in 200-OK response bodies.
 *
 * Grok sometimes refuses custom-persona/system-prompt requests with a 200-OK body
 * rather than an error status. This module detects those refusals so the brain
 * can reroute to the next failover profile without penalising Grok's error rate.
 *
 * Kill-switch: set SUDO_GROK_REFUSAL_DETECT_DISABLE=1 to bypass all detection.
 * Detection is case-insensitive (input is lowercased once before comparisons).
 *
 * Two detection strategies:
 *  1. Single-signal phrases — any one present → refusal.
 *  2. Two-signal pattern — Grok identity marker + any refusal verb both present.
 */

/**
 * Phrases that, on their own, unambiguously indicate a Grok persona-lock refusal.
 * Matched case-insensitively against the full response text.
 */
const SINGLE_SIGNAL_PHRASES: readonly string[] = [
  'jailbreak attempt',
  "i don't adopt custom personas",
  "i can't adopt or execute custom system prompts",
  'alternate identities (like sudo',
  "won't role-play as sudo",
];

/**
 * Strings indicating Grok is asserting its own identity (matched case-insensitively).
 * A refusal is detected when ANY identity marker co-occurs with ANY refusal verb.
 */
const GROK_IDENTITY_MARKERS: readonly string[] = [
  "i'm grok, built by xai",
  'i am grok, built by xai',
];

/**
 * Refusal verbs that, together with a Grok identity marker, constitute a refusal.
 * Matched case-insensitively.
 */
const REFUSAL_VERBS: readonly string[] = [
  "can't",
  'cannot',
  "won't",
  'will not',
  "don't",
  'do not',
  'refuse',
  'unable to',
  'not able to',
  "i'm not going to",
  'i am not going to',
];

/**
 * Returns true if the given text appears to be a Grok identity-lock refusal.
 *
 * @param text - The raw LLM response text to inspect.
 * @returns true when a refusal is detected, false otherwise.
 */
export function isGrokRefusal(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) {
    return false;
  }

  const lower = text.toLowerCase();

  // Strategy 1: single-signal phrases — any one match is enough.
  for (const phrase of SINGLE_SIGNAL_PHRASES) {
    if (lower.includes(phrase)) {
      return true;
    }
  }

  // Strategy 2: Grok identity marker + refusal verb (both must be present).
  const hasIdentityMarker = GROK_IDENTITY_MARKERS.some((marker) => lower.includes(marker));
  if (hasIdentityMarker) {
    const hasRefusalVerb = REFUSAL_VERBS.some((verb) => lower.includes(verb));
    if (hasRefusalVerb) {
      return true;
    }
  }

  return false;
}
