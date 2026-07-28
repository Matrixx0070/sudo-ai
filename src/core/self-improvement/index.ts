export { runSelfImprovement } from './engine.js';
export { detectPatterns } from './pattern-detector.js';
export type { DetectedPatterns, ToolStats, FeedbackPattern, RoutingGap } from './pattern-detector.js';
export type { ImprovementAction } from './engine.js';

// Upgrade 64: Self-Improvement Loop
export {
  recordInsight,
  getWeaknesses,
  getStrengths,
  getPatterns,
  analyzeForImprovement,
  getSelfReport,
} from './improvement-loop.js';
export type { ImprovementInsight, ActionRecord } from './improvement-loop.js';

// AL8.2 uniform improvement pipeline (human merge always; no auto-merge)
export { runImprovementPipeline, recordHumanMerge, _resetPipelineBudgetForTests } from './pipeline.js';
export type {
  ArtifactType,
  ArtifactPlugin,
  ImprovementDraft,
  PipelineDeps,
  PipelineOutcome,
  PipelineStage,
  StageResult,
} from './pipeline.js';
export { promptPlugin, workflowGraphPlugin, toolPlugin, codePatchPlugin } from './pipeline-plugins.js';
export type { ToolArtifactPayload } from './pipeline-plugins.js';

// AL8.4 retention ledger + quarterly re-check (flag-OFF cron)
export { RetentionLedger } from './retention-ledger.js';
export type { AdoptionRecord, RetentionRow } from './retention-ledger.js';
export { registerRetentionRecheckCron, RETENTION_RECHECK_JOB_NAME } from './retention-recheck-cron.js';
