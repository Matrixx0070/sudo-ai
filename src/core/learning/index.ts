/**
 * @file index.ts
 * @description Barrel export for the SUDO-AI learning / wisdom subsystem.
 *
 * Usage:
 * ```ts
 * import { WisdomStore } from '../core/learning/index.js';
 * import type { Insight } from '../core/learning/index.js';
 * ```
 */

export { WisdomStore } from './store.js';
export type { Insight } from './types.js';

// Upgrade 66: Learning From Failures
export {
  recordFailure,
  recordSolution,
  getPreventionRule,
  hasSeenBefore,
  getSolution,
  getFailureStats,
} from './failure-learner.js';
export type { FailureRecord } from './failure-learner.js';

// Phase 2: Persistent Trace Store
export { TraceStore } from './trace-store.js';
export type { TraceRecord, TraceQuery, TraceType } from './trace-store.js';

// Phase 2: Trace Analysis Engine
export { TraceAnalyzer } from './trace-analyzer.js';
export type { ModelToolStats, AnomalyReport } from './trace-analyzer.js';

// Phase 2: Trace-Driven Policy Engine
export { TraceDrivenPolicy } from './trace-driven-policy.js';
export type { PolicyRule, PolicyDecision } from './trace-driven-policy.js';

// Phase 2: Held-Out Non-Regression Gate
export { HeldOutGate } from './held-out-gate.js';
export type { GateTestCase, GateEvaluation } from './held-out-gate.js';

// Phase 2: Skill Forge (auto-generate skills from tool sequences)
export { SkillForge } from './skill-forge.js';
export type { ToolPattern, ForgeResult } from './skill-forge.js';

// Community-driven: Self-Improvement Safety Guard
export { SelfImprovementGuard } from './self-improvement-guard.js';
export type {
  ProposedImprovement,
  ImprovementStatus,
  ReviewResult,
  ContentDiff,
  SafetyGuardConfig,
} from './self-improvement-guard.js';

// Competitive: Session Attribution & File History
export { FileHistoryStore, fileHistoryStore } from './file-history.js';
export type {
  FileChangeRecord,
  FileChangeType,
  FileHistoryConfig,
  FileHistoryQuery,
  FileHistoryResult,
  FileHistoryStats,
  FileAttributionSummary,
  SessionAttribution,
  ContextSnapshot,
  SnapshotReason,
  FileSnapshot,
  SnapshotSignals,
  FileHistoryEvent,
} from './file-history-types.js';
export { DEFAULT_FILE_HISTORY_CONFIG } from './file-history-types.js';

// Competitive: Insights Dashboard & Analytics
export { InsightsDashboardGenerator, insightsDashboard, parseTimeRange } from './insights-dashboard.js';
export type {
  TimeRange,
  DateRange,
  SessionAnalytics,
  CostAnalytics,
  ModelCostEntry,
  ToolUsageAnalytics,
  ToolUsageEntry,
  FileChangeAnalytics,
  Anomaly,
  InsightsDashboard,
  InsightsConfig,
  InsightsFormat,
} from './insights-dashboard-types.js';
export { DEFAULT_INSIGHTS_CONFIG } from './insights-dashboard-types.js';
