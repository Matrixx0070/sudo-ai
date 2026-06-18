/**
 * @file types.ts
 * @description Type declarations for the sleep-cycle subsystem of SUDO-AI v4.
 *
 * SleepSession records a completed (or interrupted) memory consolidation cycle.
 * Duck-typed dependency interfaces prevent circular imports from sibling modules.
 *
 * Pure declarations only — no logic, no runtime imports.
 */

// ---------------------------------------------------------------------------
// SleepSession
// ---------------------------------------------------------------------------

/**
 * A record of one sleep / memory-consolidation cycle.
 * Written to the `sleep_sessions` table in consciousness.db.
 */
export interface SleepSession {
  /** Unique identifier (nanoid). */
  id: string;
  /** Number of episodic memories replayed during this cycle. */
  episodesReplayed: number;
  /** Number of new semantic patterns extracted. */
  patternsFound: number;
  /** Number of episodes whose significance was increased. */
  memoriesStrengthened: number;
  /** Number of episodes whose significance was decreased. */
  memoriesWeakened: number;
  /** Number of new insight records stored in the wisdom layer. */
  insightsGenerated: number;
  /** Number of counterfactual scenarios run during this cycle. */
  counterfactualsRun: number;
  /** Narrative dream journal entry synthesised at the end of the cycle. */
  dreamJournalEntry: string;
  /** Wall-clock duration of this cycle in milliseconds. */
  durationMs: number;
  /** ISO-8601 timestamp when the cycle started. */
  startedAt: string;
  /** ISO-8601 timestamp when the cycle ended, or null if still running. */
  endedAt: string | null;
  /** True when the cycle completed in a degraded state (early wake or partial phases). */
  degraded?: boolean;
  /** 'restrained' when the lockout window was active; 'normal' otherwise. */
  mode?: 'normal' | 'restrained';
  /** 0-1 score assigned by the IntegrityVerifier. 1.0 = fully coherent. */
  integrityScore?: number;
  /** Summary counts from the CommitmentAuditor run at end of cycle. */
  commitmentAudit?: {
    totalFlagged: number;
    expiring: number;
    expired: number;
    checkedAt: string;
  };
  /** Summary counts from the MistakePatternRecognizer run at end of cycle. */
  patternAnalysis?: {
    totalMistakes: number;
    uniquePatterns: number;
    recurringCount: number;
    analyzedAt: string;
  };
  /** Summary from CrossSignalDiagnostics run at end of cycle. */
  diagnostics?: {
    trustSpikeCount: number;
    epistemicBlockSpikeCount: number;
    vetoSpikeCount: number;
    commitmentExpirySpikeCount: number;
    topCorrelations: Array<{
      from: string;
      to: string;
      deltaMs: number;
      confidence: number;
    }>;
    totalEventsScanned: number;
    analyzedAt: string;
  };
  /** Summary from ReAnchorMonitor run at end of cycle. */
  reanchor?: {
    total: number;
    byTrigger: Record<string, number>;
    lastReAnchorAt?: number;
    analyzedAt: string;
  };
  /** Peer audit summaries pulled during post-Phase-5 audit. */
  peerAudits?: PeerAuditSummary[];
}

// ---------------------------------------------------------------------------
// PeerAuditSummary
// ---------------------------------------------------------------------------

/**
 * Summary of a peer's recent audit tail, pulled during sleep-cycle post-Phase-5.
 */
export interface PeerAuditSummary {
  /** Name of the peer (from PeerRegistry). */
  peerName: string;
  /** Number of events received in the 24h window. */
  eventCount: number;
  /** Timestamp (ms) of the newest event in the tail, if any. */
  newestTs?: number;
  /** Timestamp (ms) of the oldest event in the tail, if any. */
  oldestTs?: number;
  /** Event counts grouped by event type. */
  byEventType?: Record<string, number>;
  /** First event IDs seen (up to 10, for traceability). */
  firstInstanceIds?: string[];
  /** Set on failure: 'unreachable' | 'empty' | 'timeout'. */
  error?: string;
  /** Unix ms timestamp at which this pull was performed. */
  pulledAt: number;
}

// ---------------------------------------------------------------------------
// Duck-typed dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Minimal LLM brain interface required by the sleep-cycle subsystem.
 * Any object with a matching `call` signature is accepted.
 */
export interface SleepBrainLike {
  call(opts: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
    temperature?: number;
    source?: string;
  }): Promise<{ content: string }>;
}

/**
 * Minimal episodic memory interface required by the sleep-cycle subsystem.
 */
export interface SleepEpisodicLike {
  getBySignificance(count: number): Array<{
    id: string;
    summary: string;
    significance: number;
    outcome: string;
    topic: string;
    startedAt: string;
  }>;
  strengthenEpisode(id: string, delta: number): void;
  weakenEpisode(id: string, delta: number): void;
}

/**
 * Minimal counterfactual engine interface required by the sleep-cycle subsystem.
 * runIdleBatch handles its own episode retrieval internally.
 */
export interface SleepCounterfactualLike {
  runIdleBatch(count: number): Promise<Array<{ lessonLearned: string | null }>>;
}

/**
 * Minimal self-model interface required by the sleep-cycle subsystem.
 */
export interface SleepSelfModelLike {
  updateFromEpisode(episode: {
    id: string;
    topic: string;
    outcome: 'positive' | 'negative' | 'neutral' | 'mixed';
    significance: number;
  }): void;
}

/**
 * Minimal temporal-self interface required by the sleep-cycle subsystem.
 */
export interface SleepTemporalSelfLike {
  takeSnapshot(
    emotionalState: { dominantEmotion: string },
    goals: string[],
  ): unknown;
}

/**
 * Minimal metacognition interface required by the sleep-cycle subsystem.
 * runBatchReflection handles its own episode retrieval internally.
 */
export interface SleepMetacognitionLike {
  runBatchReflection(count: number): Promise<unknown[]>;
}

/**
 * Minimal wisdom / long-term insight store interface required by the
 * sleep-cycle subsystem.
 */
export interface SleepWisdomLike {
  storeInsight(insight: {
    category: string;
    source: string;
    insight: string;
    confidence: number;
  }): unknown;
}
