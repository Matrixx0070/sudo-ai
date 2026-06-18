/**
 * @file types.ts
 * @description Public type contracts for the CognitiveStream module.
 *
 * All dependency interfaces are duck-typed so stream.ts never imports directly
 * from sibling consciousness modules, preventing circular dependencies.
 */

import type { BodyState, EmotionalValence, ThoughtTier } from '../types.js';

// ---------------------------------------------------------------------------
// Stream-specific Thought extension
// ---------------------------------------------------------------------------

/**
 * A Thought enriched with the tier field used by the cognitive stream.
 * The base Thought interface does not include tier; we extend it here
 * so stream.ts can work with fully-typed thought objects.
 */
export interface StreamThought {
  id: string;
  content: string;
  tier: ThoughtTier;
  timestamp: string;
  source: string;
  activatedConcepts: string[];
  emotionalValence: EmotionalValence;
  bodyStateSnapshot: BodyState;
  parentThoughtId: string | null;
  depth: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Tunable parameters for the CognitiveStream.
 * All fields have safe defaults applied in stream.ts.
 */
export interface ThoughtConfig {
  /** Milliseconds between micro-thought ticks. Default: 60000 */
  microIntervalMs: number;
  /** Every Nth tick produces a medium thought. Default: 10 */
  mediumEveryN: number;
  /** Every Nth tick produces a deep thought. Default: 120 */
  deepEveryN: number;
  /** Model used for micro thoughts (cheapest). Default: '' (caller sets) */
  microModel: string;
  /** Model used for medium thoughts. Default: '' (caller sets) */
  mediumModel: string;
  /** Model used for deep thoughts. Default: '' (caller sets) */
  deepModel: string;
  /** Max tokens for micro thought generation. Default: 80 */
  maxMicroTokens: number;
  /** Max tokens for medium thought generation. Default: 300 */
  maxMediumTokens: number;
  /** Max tokens for deep thought generation. Default: 1500 */
  maxDeepTokens: number;
}

// ---------------------------------------------------------------------------
// Stream state snapshot
// ---------------------------------------------------------------------------

/** Point-in-time snapshot of the CognitiveStream's operational state. */
export interface StreamState {
  isRunning: boolean;
  currentThought: StreamThought | null;
  thoughtCount: number;
  lastThoughtAt: string | null;
  activeConcepts: string[];
  currentTier: ThoughtTier;
}

// ---------------------------------------------------------------------------
// Interrupt result
// ---------------------------------------------------------------------------

/**
 * Returned by CognitiveStream.interrupt() when a user message arrives.
 * Gives the caller a snapshot of the mid-thought context so the AI feels
 * like it was caught thinking.
 */
export interface InterruptResult {
  /** The thought that was in progress (from cache) when the interrupt arrived. */
  interruptedThought: StreamThought | null;
  /** Plain-text summary of the last few thoughts for system prompt injection. */
  contextSummary: string;
  /** Concept IDs that were most recently active. */
  activeConcepts: string[];
  /** Current emotional state at moment of interrupt. */
  emotionalState: EmotionalValence;
}

// ---------------------------------------------------------------------------
// Brain duck type
// ---------------------------------------------------------------------------

/**
 * Minimal interface that any LLM brain must satisfy.
 * Using a duck type avoids a direct import of the Brain class.
 */
export interface StreamBrainLike {
  call(options: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ content: string }>;
}

// ---------------------------------------------------------------------------
// Dependency duck types (prevent circular imports)
// ---------------------------------------------------------------------------

/** Minimal body-state provider interface. */
export interface BodyStateLike {
  getState(): BodyState;
}

/** Minimal spreading-activation interface. */
export interface SpreadingActivationLike {
  activate(concepts: string[], intensity?: number): unknown;
  getTopActive(count: number): Array<{ id: string; activation: number }>;
}

/** Minimal emotional-state interface. */
export interface EmotionalStateLike {
  getCurrentState(): EmotionalValence;
  updateFromThought(thought: StreamThought): EmotionalValence;
}

// ---------------------------------------------------------------------------
// Internal context shape (passed from stream.ts to thought-generator.ts)
// ---------------------------------------------------------------------------

/**
 * Rich context assembled by the stream before each thought generation call.
 * Passed to thought-generator.ts; not exported from the module barrel.
 */
export interface ThoughtContext {
  tier: ThoughtTier;
  bodyState: BodyState;
  activeConcepts: string[];
  emotionalState: EmotionalValence;
  recentThoughts: StreamThought[];
}
