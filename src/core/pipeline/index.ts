/**
 * Barrel export for src/core/pipeline.
 */

export { PipelineOrchestrator } from './orchestrator.js';
export { RemotionBridge } from './remotion-bridge.js';
export type { RenderOptions, RenderProgress, StillOptions, ProgressCallback } from './remotion-bridge.js';

export type {
  PipelineStage,
  PipelineRun,
  PipelineRunOptions,
  DirectorPlan,
  ScenePlan,
  CharacterDNA,
  QualityReport,
  QualityCheck,
  ResearchData,
  ImageGenResult,
  VideoGenResult,
  VoiceResult,
  MusicResult,
  SfxResult,
  AssemblyResult,
} from './types.js';

export { PIPELINE_STAGES } from './types.js';
