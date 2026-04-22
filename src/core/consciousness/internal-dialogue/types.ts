/**
 * @file types.ts
 * @description Local type definitions for the internal-dialogue module.
 *
 * Re-uses VoiceName and VoicePosition from the parent consciousness layer.
 * No logic lives here — pure declarations only.
 */

import type { VoiceName, VoicePosition } from '../types.js';

// Re-export for consumers that import entirely from this sub-module.
export type { VoiceName, VoicePosition };

// ---------------------------------------------------------------------------
// Debate
// ---------------------------------------------------------------------------

/**
 * A completed internal deliberation round.
 * Four voice positions are weighed and a winning resolution is produced.
 */
export interface Debate {
  /** Unique identifier (nanoid). */
  id: string;
  /** The question or decision that was debated. */
  question: string;
  /** Surrounding context supplied at debate time. */
  context: string;
  /** One position per inner voice. */
  positions: VoicePosition[];
  /** Natural-language resolution produced by the winning voice. */
  resolution: string;
  /** The inner voice that won the weighted vote. */
  winningVoice: VoiceName;
  /** Normalised confidence of the winning voice (0..1). */
  confidence: number;
  /** Context type used to select voice weights. */
  contextType: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// VoiceWeights
// ---------------------------------------------------------------------------

/**
 * Weight assigned to each inner voice for a specific context type.
 * All four weights should sum to 1.0.
 */
export interface VoiceWeights {
  analyst: number;
  creative: number;
  skeptic: number;
  strategist: number;
}

// ---------------------------------------------------------------------------
// DialogueBrainLike
// ---------------------------------------------------------------------------

/**
 * Minimal interface for an LLM brain that the internal-dialogue module
 * depends upon. Keeps the module decoupled from a concrete brain implementation.
 */
export interface DialogueBrainLike {
  call(opts: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ content: string }>;
}
