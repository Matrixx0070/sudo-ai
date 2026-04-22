/**
 * @file index.ts
 * Barrel export for the entire SUDO-AI pipeline module.
 * Import anything pipeline-related from this single entry point.
 */

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export { runBatch, runDailyCron, getBatchConfig } from './daily-batch.js';

// Batch state helpers (load/save PipelineState and BatchResult)
export { loadState, saveState, saveBatchResult, maybeResetDailyCost, STATE_FILE, BATCHES_DIR } from './batch-state.js';

// ---------------------------------------------------------------------------
// Topic selection
// ---------------------------------------------------------------------------

export {
  selectTopics,
  loadTopicBank,
  getAvailableTopics,
  isTopicRecentlyUsed,
} from './topic-selector.js';

// ---------------------------------------------------------------------------
// Script generation
// ---------------------------------------------------------------------------

export { generateScript } from './script-generator.js';

// ---------------------------------------------------------------------------
// Scene rendering
// ---------------------------------------------------------------------------

export { renderScenes } from './scene-renderer.js';

// ---------------------------------------------------------------------------
// Voice generation
// ---------------------------------------------------------------------------

export { generateVoice } from './voice-generator.js';

// ---------------------------------------------------------------------------
// Video assembly
// ---------------------------------------------------------------------------

export { assembleVideo } from './video-assembler.js';

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

export { runQualityCheck } from './quality-gate.js';

// ---------------------------------------------------------------------------
// SEO tagging
// ---------------------------------------------------------------------------

export { generateSeoMetadata } from './seo-tagger.js';

// ---------------------------------------------------------------------------
// YouTube upload
// ---------------------------------------------------------------------------

export { uploadToYouTube, checkQuotaAvailable } from './youtube-uploader.js';

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export { sendNotification, sendDailySummary } from './notifier.js';

// ---------------------------------------------------------------------------
// Optimizer
// ---------------------------------------------------------------------------

export {
  runOptimization,
  getOptimizationHints,
  recordVideoPerformance,
} from './optimizer.js';

// ---------------------------------------------------------------------------
// Assembler filter helpers (internal, but exported for integration testing)
// ---------------------------------------------------------------------------

export {
  buildFilterComplex,
  buildZoompanFilter,
  buildSubtitleFilter,
  resolveSceneDuration,
  OUTPUT_WIDTH,
  OUTPUT_HEIGHT,
  OUTPUT_FPS,
  FALLBACK_SCENE_DURATION,
  SUBTITLE_FONT_SIZE,
  SUBTITLE_COLOR,
  SUBTITLE_BOX_COLOR,
  SUBTITLE_BOX_BORDER,
} from './assembler-filters.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type {
  TopicEntry,
  TopicCategory,
  TopicBank,
  SelectedTopic,
  SceneScript,
  GeneratedScript,
  CharacterInfo,
  SceneAssets,
  RenderedScenes,
  GeneratedVoice,
  SceneTimestamp,
  AssembledVideo,
  QualityCheckResult,
  QualityGateResult,
  SeoMetadata,
  UploadResult,
  NotificationPayload,
  VideoPerformance,
  OptimizationResult,
  VideoFormat,
  PipelineVideoConfig,
  BatchVideoStatus,
  BatchVideoResult,
  BatchResult,
  DailyBatchConfig,
  BatchSchedule,
  TopicUsageRecord,
  PipelineState,
} from './types.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export { VIDEO_FORMAT_CONFIG } from './types.js';
