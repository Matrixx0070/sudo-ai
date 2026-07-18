/**
 * @file index.ts
 * @description Barrel export for the SUDO-AI v4 consciousness layer.
 *
 * Consumers import everything they need from this single entry point:
 *
 * ```ts
 * import {
 *   ConsciousnessDB,
 *   ConsciousnessError,
 *   type BodyState,
 *   type Thought,
 *   type EmotionTag,
 * } from '../consciousness/index.js';
 * ```
 */

// Errors
export { ConsciousnessError } from './errors.js';

// Database wrapper
export { ConsciousnessDB } from './consciousness-db.js';

// Context selector (consciousness bridge)
export { ContextSelector } from './context-selector.js';
export type { ContextSelection, ModuleRelevance } from './context-selector.js';

// Consciousness bridge
export { ConsciousnessBridge } from './context-bridge.js';
export type { BridgeInjection } from './context-bridge.js';

// HEARTBEAT morning briefing (community-driven feature)
export { HeartbeatEngine } from './heartbeat.js';
export type {
  MorningBriefing,
  BriefingCalendarEvent,
  BriefingTask,
  BriefingHealthObservation,
  BriefingMemoryHighlight,
  BriefingGoal,
  BriefingCostMetrics,
  BriefingSkillStats,
  HeartbeatConfig,
} from './heartbeat.js';

// (F98) DreamConsolidator + consciousness/auto-dream retired 2026-07-18 —
// zero runtime callers; src/core/memory/auto-dream.ts (cron auto-dream-consolidation,
// 6h) is the one dream engine. Unique orphan behaviors noted in the F98 commit
// (daily-log .md ingestion; brain-less idle compaction) as port-candidates.

// Cron scheduler (scheduled tasks with persistence + jitter)
export { CronScheduler } from './cron-scheduler.js';
export type {
  CronTask,
  CronSchedulerConfig,
  TaskKind,
  CronMatch,
} from './cron-scheduler.js';

// Session compactor (intelligent context compression)
export { SessionCompactor } from './session-compactor.js';
export type {
  CompactionResult,
  SessionCompactorConfig,
  ToolCall,
  ThinkingBlock,
  ConversationTurn,
  SessionContext,
} from './session-compactor.js';

// All shared types
export type {
  BodyState,
  EmotionTag,
  EmotionalValence,
  Thought,
  ThoughtTier,
  DriveState,
  Prediction,
  UserModel,
  RelationshipStage,
  AttentionSignal,
  CapabilityAssessment,
  VoiceName,
  VoicePosition,
  ConsolidationResult,
} from './types.js';

// Orchestrator (main entry point for consciousness layer)
export { ConsciousnessOrchestrator } from './orchestrator.js';
export type {
  ConsciousnessState,
  OrchestratorBrainLike,
  CounterfactualInsight,
  MetacognitiveInsight,
  SurpriseInsight,
  TemporalInsight,
  UserAdaptation,
  DeepInsights,
} from './orchestrator.js';
