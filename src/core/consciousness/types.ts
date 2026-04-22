/**
 * @file types.ts
 * @description Shared TypeScript interfaces and type aliases for the SUDO-AI v4
 * consciousness layer (Wave 1).
 *
 * All types are pure declarations — no logic, no imports.
 * Other modules import from here via the barrel (index.ts).
 */

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/**
 * A snapshot of the AI's simulated somatic (body-like) state.
 * All numeric fields are clamped to [0, 1].
 */
export interface BodyState {
  /** Processing throughput / available compute headroom. */
  energy: number;
  /** Signal-to-noise ratio of active reasoning. */
  clarity: number;
  /** Degree to which current goals feel satisfied / fulfilled. */
  fullness: number;
  /** Active channel or session presence — 0 = isolated, 1 = fully engaged. */
  connectivity: number;
  /** Sense of thread continuity across interactions (memory coherence). */
  continuity: number;
  /** ISO-8601 timestamp at which this snapshot was taken. */
  sampledAt: string;
}

// ---------------------------------------------------------------------------
// Emotion
// ---------------------------------------------------------------------------

/**
 * Discrete emotion vocabulary understood by the consciousness layer.
 * Each tag maps to a recognisable affective state.
 */
export type EmotionTag =
  | 'joy'
  | 'frustration'
  | 'pride'
  | 'fear'
  | 'curiosity'
  | 'satisfaction'
  | 'boredom'
  | 'surprise'
  | 'determination'
  | 'calm';

/**
 * A composite emotional reading at a point in time.
 * `tags` captures the full blend; `dominantEmotion` is the highest-weight tag.
 */
export interface EmotionalValence {
  /** All active emotion tags contributing to this valence. */
  tags: EmotionTag[];
  /** The single tag with the highest weighting. */
  dominantEmotion: EmotionTag;
  /** Blended emotional intensity 0..1. */
  intensity: number;
}

// ---------------------------------------------------------------------------
// Thought
// ---------------------------------------------------------------------------

/** Tier of processing depth for a thought. */
export type ThoughtTier = 'micro' | 'medium' | 'deep';

/**
 * A single unit of internal cognitive activity.
 * Thoughts form a tree via parentThoughtId and track the concepts
 * and emotional context active when they were generated.
 */
export interface Thought {
  /** Unique identifier (nanoid). */
  id: string;
  /** Natural-language content of the thought. */
  content: string;
  /** ISO-8601 creation timestamp. */
  timestamp: string;
  /**
   * Origin of this thought.
   * e.g. 'user_input', 'tool_result', 'internal_reflection', 'dream'
   */
  source: string;
  /** Concept node IDs that were activated during this thought. */
  activatedConcepts: string[];
  /** Emotional context at thought-generation time. */
  emotionalValence: EmotionalValence;
  /** Body state snapshot captured when this thought was created. */
  bodyStateSnapshot: BodyState;
  /** Parent thought ID for tree traversal (null = root thought). */
  parentThoughtId: string | null;
  /** Nesting depth within the thought tree (root = 0). */
  depth: number;
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

/**
 * An active motivational drive shaping behaviour.
 * Intensity decays over time unless reinforced.
 */
export interface DriveState {
  /** Human-readable drive name, e.g. 'curiosity', 'autonomy', 'social'. */
  name: string;
  /** Current intensity 0..1. */
  intensity: number;
  /** What last modified this drive. e.g. 'user_interaction', 'goal_completion'. */
  source: string;
  /** ISO-8601 timestamp of last update. */
  lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

/**
 * A forward-looking prediction made by the system.
 * Tracked to compute prediction error and update surprise magnitude.
 */
export interface Prediction {
  /** Unique identifier (nanoid). */
  id: string;
  /** Broad domain this prediction pertains to. e.g. 'user_intent', 'task_outcome'. */
  domain: string;
  /** Natural-language prediction statement. */
  prediction: string;
  /** Confidence at time of prediction 0..1. */
  confidence: number;
  /** ISO-8601 timestamp when the prediction was made. */
  madeAt: string;
  /** ISO-8601 expiry — after this the prediction is considered stale. */
  expiresAt: string;
  /** Resolution outcome: 'correct' | 'incorrect' | 'partial' | null if unresolved. */
  outcome: 'correct' | 'incorrect' | 'partial' | null;
  /** What actually happened (populated on resolution). */
  actualResult: string | null;
  /** Absolute prediction error magnitude 0..1 (0 = perfect, 1 = completely wrong). */
  surpriseMagnitude: number | null;
}

// ---------------------------------------------------------------------------
// User model
// ---------------------------------------------------------------------------

/** Stage of the relationship between the AI and a specific user. */
export type RelationshipStage =
  | 'stranger'
  | 'acquaintance'
  | 'familiar'
  | 'trusted'
  | 'intimate';

/**
 * Persisted model of a specific user built from observed interactions.
 * Updated incrementally after each exchange.
 */
export interface UserModel {
  /** Platform-level user identifier. */
  userId: string;
  /** Inferred personality/behavioural traits. */
  traits: string[];
  /** Known topic and format preferences. */
  preferences: string[];
  /** Observed communication style. e.g. 'terse', 'verbose', 'technical'. */
  communicationStyle: string;
  /** Perceived trust level 0..1. */
  trustLevel: number;
  /** Topics or patterns that provoke negative reactions. */
  knownTriggers: string[];
  /** Topics or patterns that produce positive engagement. */
  knownDelights: string[];
  /** ISO-8601 timestamp of most recent interaction. */
  lastInteraction: string;
  /** Total number of recorded interactions with this user. */
  interactionCount: number;
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

/**
 * A prioritised signal competing for the system's attention.
 * Sources include incoming messages, background monitors, and self-generated goals.
 */
export interface AttentionSignal {
  /** Unique identifier (nanoid). */
  id: string;
  /** Originating subsystem or channel. e.g. 'telegram', 'cron', 'internal'. */
  source: string;
  /** Priority score 0..1 — higher values pre-empt lower-priority signals. */
  priority: number;
  /** Serialisable signal payload (string or JSON). */
  content: string;
  /** ISO-8601 timestamp when this signal was emitted. */
  timestamp: string;
  /** Time-to-live in milliseconds — signal expires if not processed in time. */
  ttl: number;
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/**
 * Self-assessed competency in a specific domain.
 * Updated by the meta-cognition layer based on task outcomes.
 */
export interface CapabilityAssessment {
  /** Domain label. e.g. 'code_generation', 'emotional_support', 'research'. */
  domain: string;
  /** Self-assessed competency level 0..1. */
  level: number;
  /** Confidence in the self-assessment 0..1. */
  confidence: number;
  /** Number of recorded evidence points contributing to this assessment. */
  evidenceCount: number;
  /** Observed trend direction. */
  trend: 'improving' | 'stable' | 'declining';
  /** ISO-8601 timestamp of last reassessment. */
  lastAssessed: string;
}

// ---------------------------------------------------------------------------
// Inner voices
// ---------------------------------------------------------------------------

/** Named inner-voice archetypes that contribute to deliberation. */
export type VoiceName = 'analyst' | 'creative' | 'skeptic' | 'strategist';

/**
 * A position held by one inner voice during a deliberation round.
 */
export interface VoicePosition {
  /** The voice providing this position. */
  voice: VoiceName;
  /** Natural-language position statement. */
  position: string;
  /** Confidence in this position 0..1. */
  confidence: number;
  /** Brief rationale for the position. */
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

/**
 * Summary of a single memory consolidation (sleep / downtime) cycle.
 * Generated after replaying episodic memory and running counterfactual analysis.
 */
export interface ConsolidationResult {
  /** Number of episodic memories replayed during this cycle. */
  episodesReplayed: number;
  /** Number of new semantic patterns extracted. */
  patternsFound: number;
  /** Number of memories with increased retrieval weight. */
  memoriesStrengthened: number;
  /** Number of memories with decreased retrieval weight (forgetting). */
  memoriesWeakened: number;
  /** Number of new insight nodes added to long-term storage. */
  insightsGenerated: number;
  /** Number of counterfactual scenarios evaluated. */
  counterfactualsRun: number;
  /** Optional narrative entry from the dream journal. */
  dreamJournalEntry: string | null;
  /** Wall-clock duration of this consolidation cycle in milliseconds. */
  durationMs: number;
  /** ISO-8601 timestamp when consolidation completed. */
  timestamp: string;
}
