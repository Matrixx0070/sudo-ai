/**
 * @file types.ts
 * @description Pure type declarations for the self-evolution subsystem.
 *
 * No logic, no imports. All other modules in this directory import types
 * from here. External consumers import via the barrel (index.ts).
 */

// ---------------------------------------------------------------------------
// Evolution proposal
// ---------------------------------------------------------------------------

/**
 * A proposed change to the system's code, tools, soul, or configuration.
 * Proposals require explicit owner approval before being applied.
 */
export interface EvolutionProposal {
  /** Unique identifier (nanoid). */
  id: string;
  /** Category of the proposed change. */
  type: 'code-fix' | 'new-tool' | 'soul-update' | 'config-change';
  /** File path or config key that this proposal targets. */
  target: string;
  /** Human-readable description of what this proposal does. */
  description: string;
  /** Snapshot of the current content at `target`, or null if new. */
  currentCode: string | null;
  /** The full replacement content this proposal would write. */
  proposedCode: string | null;
  /** LLM-generated reasoning behind this proposal. */
  reasoning: string;
  /** Confidence score 0..1. */
  confidence: number;
  /** Lifecycle state of this proposal. */
  status: 'proposed' | 'approved' | 'applied' | 'rejected' | 'failed';
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Digital DNA
// ---------------------------------------------------------------------------

/**
 * The AI's unique genetic identity — generated once at birth, evolved over
 * time through the `growthHistory` log.
 */
export interface DigitalDNA {
  /** Random UUID that uniquely identifies this instance. */
  seed: string;
  /** ISO-8601 timestamp when this DNA was first generated. */
  birthDate: string;
  /** Seed of the parent instance, or null if this is a first-generation entity. */
  parentDNA: string | null;
  /** Per-trait bias values (0..1) shaping personality expression. */
  traitBiases: Record<string, number>;
  /** Ordered log of notable growth or evolution events. */
  growthHistory: string[];
}

// ---------------------------------------------------------------------------
// Failure pattern
// ---------------------------------------------------------------------------

/**
 * A recurring error signature tracked by the self-evolution layer.
 * When occurrence_count crosses a threshold it may trigger a fix proposal.
 */
export interface FailurePattern {
  /** Auto-increment row id from SQLite. */
  id: number;
  /** Normalised string representing the error class. */
  errorSignature: string;
  /** Number of times this signature has been observed. */
  occurrenceCount: number;
  /** ISO-8601 timestamp of first observation. */
  firstSeen: string;
  /** ISO-8601 timestamp of most recent observation. */
  lastSeen: string;
  /** Whether a fix has been applied and confirmed. */
  resolved: boolean;
}

// ---------------------------------------------------------------------------
// Duck-typed interfaces for injected dependencies
// ---------------------------------------------------------------------------

/**
 * Minimal interface required from a brain/LLM provider.
 * Avoids tight coupling to any specific brain implementation.
 */
export interface EvoBrainLike {
  call(opts: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ content: string }>;
}

/**
 * Minimal interface required from a self-model.
 * Avoids tight coupling to the full SelfModel implementation.
 */
export interface EvoSelfModelLike {
  getWeaknesses(count?: number): Array<{ domain: string; level: string; confidence: number }>;
  getStrengths(count?: number): Array<{ domain: string; level: string; confidence: number }>;
}
