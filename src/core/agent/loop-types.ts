/**
 * @file loop-types.ts
 * @description Duck-typed interfaces consumed by AgentLoop.
 *
 * Extracted from loop.ts (refactor #229) to keep the orchestrator file under
 * a workable size without changing any runtime behaviour. Every interface
 * here was originally declared INSIDE loop.ts; moving them out is a pure
 * compile-time change. Type-only — emits no JS, so nothing else needs to
 * be touched at the dist/ layer.
 *
 * Conventions:
 *   - Each interface defines the MINIMAL slice loop.ts needs from a
 *     collaborator, so the orchestrator stays decoupled from concrete
 *     implementations (real SessionManager, real Consciousness, real
 *     UnifiedMemory, real Predictor).
 *   - Inline `import('...').T` for cross-module types keeps this file
 *     dependency-free at the top — anything that imports loop-types.ts
 *     does NOT also pull in orchestrator.js, channels/types.js, etc.
 */

import type { Prediction } from '../prediction/predictor.js';
import type { SessionLike } from './loop-helpers.js';

// ---------------------------------------------------------------------------
// Duck-typed SessionManager interface
// ---------------------------------------------------------------------------

export interface SessionManagerLike {
  get(sessionId: string): Promise<SessionLike | undefined>;
  save(session: SessionLike): Promise<void>;
  archive(sessionId: string): Promise<void>;
  getOrCreate(channel: import('../channels/types.js').ChannelType, peerId: string): Promise<SessionLike>;
}

// ---------------------------------------------------------------------------
// Duck-typed Consciousness interface
// ---------------------------------------------------------------------------

export interface ConsciousnessLike {
  onInteractionStart(
    userId: string,
    message: string,
  ): Promise<{ contextSummary: string; activeConcepts: string[] }>;
  onInteractionEnd(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
    outcome: string,
    toolNames?: string[],
  ): Promise<void>;
  getConsciousnessContext(): string;
  getIntelligenceBriefContext?: (message: string) => {
    dominantDrive: { name: string; intensity: number } | null;
    emotionalState: { emotion: string; intensity: number } | null;
    matchingProcedure: { name: string; steps: string[]; successRate: number } | null;
    relevantPredictions: Array<{ domain: string; prediction: string; confidence: number; outcome: string }>;
    recentEpisodes: Array<{ summary: string; outcome: string; significance: number; timestamp: string }>;
    counterfactualLessons?: Array<{ lessonLearned: string; deltaAssessment: string }>;
    metacognitiveReflections?: Array<{ conclusion: string; actionItem: string }>;
    surpriseLevel?: number;
    temporalNarrative?: string;
    activeConcepts?: string[];
  };
  /** Deep-bridge methods — surfaced by ConsciousnessOrchestrator. */
  getDeepInsights?(userId: string): import('../consciousness/orchestrator.js').DeepInsights;
  getCounterfactualLessons?(count?: number): import('../consciousness/orchestrator.js').CounterfactualInsight[];
  getMetacognitiveGuidance?(limit?: number): import('../consciousness/orchestrator.js').MetacognitiveInsight[];
  getSurpriseInsight?(hours?: number): import('../consciousness/orchestrator.js').SurpriseInsight;
  getTemporalNarrative?(): import('../consciousness/orchestrator.js').TemporalInsight;
  getUserAdaptation?(userId: string): import('../consciousness/orchestrator.js').UserAdaptation | null;
  getRelationshipContext?(userId: string): string;
  getDriveInfluenceForAgent?(): { promptAddition: string; temperatureDelta: number };
  getActiveConcepts?(count?: number): string[];
}

// ---------------------------------------------------------------------------
// Duck-typed UnifiedMemory interface
// ---------------------------------------------------------------------------

export interface UnifiedMemoryLike {
  search(params: { query: string; limit?: number }): Promise<Array<{ content?: string; text?: string; source?: string; score?: number; relevance?: number }>>;
}

// ---------------------------------------------------------------------------
// Duck-typed Predictor interface
// ---------------------------------------------------------------------------

/** Minimal slice of Predictor the loop needs for opt-in anticipatory injection. */
export interface PredictorLike {
  anticipate(): Promise<Prediction[]>;
}
