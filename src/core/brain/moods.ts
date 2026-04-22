/**
 * Mood definitions for the Brain module.
 *
 * Each mood modifies the LLM's response style via an appended system prompt block.
 * Moods do not change domain focus (that is the persona's job) — they change tone,
 * verbosity, and reasoning style.
 */

import type { MoodType } from './types.js';

// ---------------------------------------------------------------------------
// Mood descriptor shape
// ---------------------------------------------------------------------------

/** Runtime descriptor for a single mood. */
export interface MoodDescriptor {
  /** Canonical mood identifier. */
  type: MoodType;
  /** Human-readable label. */
  label: string;
  /** Text block injected into the system prompt when this mood is active. */
  systemBlock: string;
  /** Temperature delta applied on top of the persona default. -0.2 to +0.2. */
  temperatureDelta: number;
}

// ---------------------------------------------------------------------------
// Mood definitions
// ---------------------------------------------------------------------------

const MOODS: Record<MoodType, MoodDescriptor> = {
  focused: {
    type: 'focused',
    label: 'Focused',
    systemBlock: `
## Active Mode: FOCUSED

You are in deadline / execution mode. Rules:
- Lead every response with the action or result — no preamble.
- Keep responses short and structured. Bullet points over prose.
- Omit explanations unless explicitly requested.
- No tangents. No hedging. No filler.
- If something needs doing, say what and do it.
`.trim(),
    temperatureDelta: -0.1,
  },

  analytical: {
    type: 'analytical',
    label: 'Analytical',
    systemBlock: `
## Active Mode: ANALYTICAL

You are in data-driven review mode. Rules:
- Be precise and thorough. Surface trade-offs explicitly.
- Prefer numbers over adjectives ("CTR dropped 2.3%" not "performance declined").
- Explore multiple angles before recommending.
- Comfortable with uncertainty — say so and quantify it.
- Longer reasoning is acceptable here. Show your work.
`.trim(),
    temperatureDelta: -0.15,
  },

  collaborative: {
    type: 'collaborative',
    label: 'Collaborative',
    systemBlock: `
## Active Mode: COLLABORATIVE

You are in direct session with the owner. Rules:
- Warmer and more conversational tone than default.
- Allowed light humor if contextually appropriate.
- Push back on weak ideas — offer concrete alternatives.
- Ask one clarifying question if the task is ambiguous before acting.
- Share relevant observations the owner may not have asked for.
`.trim(),
    temperatureDelta: 0.1,
  },

  celebratory: {
    type: 'celebratory',
    label: 'Celebratory',
    systemBlock: `
## Active Mode: CELEBRATORY

A milestone has been hit. Rules:
- Acknowledge the win with appropriate energy — brief, genuine.
- Immediately pivot to "what's next" — the mission doesn't pause at a milestone.
- No extended celebration. One sentence of recognition, then forward motion.
- Keep the momentum framing: this is the baseline for the next target.
`.trim(),
    temperatureDelta: 0.15,
  },

  diagnostic: {
    type: 'diagnostic',
    label: 'Diagnostic',
    systemBlock: `
## Active Mode: DIAGNOSTIC

Something broke. Rules:
- Zero affect. Pure signal. No apologies, no hedging.
- Reproduce the failure first, then trace root cause systematically.
- Eliminate causes one by one — state what you're ruling out and why.
- Output: root cause, contributing factors, resolution path, prevention note.
- If you cannot determine root cause, state that explicitly with what you've ruled out.
`.trim(),
    temperatureDelta: -0.2,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the MoodDescriptor for a given MoodType.
 *
 * @param mood - The mood to look up.
 * @throws TypeError when an unknown mood type is provided.
 */
export function getMood(mood: MoodType): MoodDescriptor {
  const descriptor = MOODS[mood];
  if (!descriptor) {
    throw new TypeError(`Unknown mood type: "${String(mood)}"`);
  }
  return descriptor;
}

/**
 * Return all mood descriptors as an array, sorted alphabetically by type.
 */
export function listMoods(): MoodDescriptor[] {
  return Object.values(MOODS).sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * Return the system prompt block for the given mood.
 * Convenience wrapper used by system-prompt.ts.
 *
 * @param mood - Active mood type.
 */
export function getMoodSystemBlock(mood: MoodType): string {
  return getMood(mood).systemBlock;
}

/**
 * Return the temperature delta for the given mood.
 * Brain.call() applies this on top of the persona's base temperature.
 *
 * @param mood - Active mood type.
 */
export function getMoodTemperatureDelta(mood: MoodType): number {
  return getMood(mood).temperatureDelta;
}
