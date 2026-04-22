/**
 * @file types.ts
 * Shared type definitions for the autonomous YouTube content pipeline.
 * Every pipeline module imports from this file — it imports nothing from pipeline/.
 */

// ---------------------------------------------------------------------------
// Topic Types
// ---------------------------------------------------------------------------

export interface TopicEntry {
  id: string;              // e.g. "BET-001"
  title: string;           // Hinglish topic title
  hook: string;            // Pre-written Scene 1 hook line
  emotion: string;         // e.g. "shock", "anger"
  viral_score: number;     // 1-10
}

export interface TopicCategory {
  description: string;
  topics: TopicEntry[];
}

export interface TopicBank {
  version: string;
  totalTopics: number;
  categories: Record<string, TopicCategory>;
  metadata: Record<string, string>;
}

export interface SelectedTopic {
  entry: TopicEntry;
  category: string;
  selectedAt: string;       // ISO datetime
  batchId: string;
}

// ---------------------------------------------------------------------------
// Script Types
// ---------------------------------------------------------------------------

export interface SceneScript {
  index: number;            // 1-based
  narration: string;
  description: string;      // Visual scene description
  emotion: string;
  durationTarget: number;   // Target seconds (3 or 4)
}

export interface GeneratedScript {
  topic: SelectedTopic;
  title: string;
  scenes: SceneScript[];
  characters: CharacterInfo[];
  totalDurationTarget: number;
  hookLine: string;
  ctaQuestion: string;
  rawNarration: string;     // Full concatenated narration text
}

export interface CharacterInfo {
  name: string;
  role: 'protagonist' | 'antagonist' | 'supporting';
  description: string;
}

// ---------------------------------------------------------------------------
// Asset Types
// ---------------------------------------------------------------------------

export interface SceneAssets {
  sceneIndex: number;
  imagePath?: string;
  videoClipPath?: string;
  templateId?: string;
}

export interface RenderedScenes {
  assets: SceneAssets[];
  method: 'image-gen' | 'remotion-template' | 'hybrid';
  costUsd: number;
}

export interface GeneratedVoice {
  audioPath: string;
  durationSeconds: number;
  sceneTimestamps: SceneTimestamp[];
  costUsd: number;
}

export interface SceneTimestamp {
  sceneIndex: number;
  startSeconds: number;
  endSeconds: number;
}

export interface AssembledVideo {
  videoPath: string;
  thumbnailPath: string;
  durationSeconds: number;
  fileSizeBytes: number;
  resolution: { width: number; height: number };
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Quality Types
// ---------------------------------------------------------------------------

export interface QualityCheckResult {
  name: string;
  passed: boolean;
  actual: string;
  expected: string;
}

export interface QualityGateResult {
  passed: boolean;
  checks: QualityCheckResult[];
  videoPath: string;
  grade: 'A' | 'B' | 'C' | 'FAIL';
}

// ---------------------------------------------------------------------------
// SEO Types
// ---------------------------------------------------------------------------

export interface SeoMetadata {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  categoryId: string;
  language: string;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Upload Types
// ---------------------------------------------------------------------------

export interface UploadResult {
  youtubeVideoId: string;
  youtubeUrl: string;
  scheduledPublishAt?: string;
  status: 'uploaded' | 'scheduled' | 'failed';
  quotaUsed: number;
}

// ---------------------------------------------------------------------------
// Notification Types
// ---------------------------------------------------------------------------

export interface NotificationPayload {
  type: 'batch_start' | 'video_complete' | 'video_failed' | 'batch_complete' | 'daily_summary';
  batchId: string;
  message: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Optimizer Types
// ---------------------------------------------------------------------------

export interface VideoPerformance {
  youtubeVideoId: string;
  topicId: string;
  category: string;
  views: number;
  likes: number;
  comments: number;
  ctr: number;
  avgRetention: number;
  publishedAt: string;
  collectedAt: string;
}

export interface OptimizationResult {
  topicWeightAdjustments: Record<string, number>;
  bestUploadHours: number[];
  bestThumbnailStyle: string;
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Batch Types
// ---------------------------------------------------------------------------

export type VideoFormat = 'short' | 'long';

export interface PipelineVideoConfig {
  format: VideoFormat;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  resolution: { width: number; height: number };
}

export const VIDEO_FORMAT_CONFIG: Record<VideoFormat, PipelineVideoConfig> = {
  short: {
    format: 'short',
    minDurationSeconds: 25,
    maxDurationSeconds: 60,
    resolution: { width: 1080, height: 1920 },
  },
  long: {
    format: 'long',
    minDurationSeconds: 480,
    maxDurationSeconds: 900,
    resolution: { width: 1920, height: 1080 },
  },
};

export type BatchVideoStatus =
  | 'pending' | 'scripting' | 'rendering' | 'voicing'
  | 'assembling' | 'quality_check' | 'tagging'
  | 'uploading' | 'complete' | 'failed' | 'skipped';

export interface BatchVideoResult {
  videoId: string;
  topic: SelectedTopic;
  status: BatchVideoStatus;
  format: VideoFormat;
  script?: GeneratedScript;
  scenes?: RenderedScenes;
  voice?: GeneratedVoice;
  assembly?: AssembledVideo;
  quality?: QualityGateResult;
  seo?: SeoMetadata;
  upload?: UploadResult;
  totalCostUsd: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface BatchResult {
  batchId: string;
  scheduleName: string;
  videos: BatchVideoResult[];
  totalCostUsd: number;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'complete' | 'partial' | 'failed';
}

export interface DailyBatchConfig {
  schedules: BatchSchedule[];
  maxCostPerBatchUsd: number;
  maxCostPerDayUsd: number;
  maxRetries: number;
  staggerDelayMs: number;
}

export interface BatchSchedule {
  name: string;
  cronExpression: string;
  videoCount: number;
  format: VideoFormat;
}

// ---------------------------------------------------------------------------
// State Persistence
// ---------------------------------------------------------------------------

export interface TopicUsageRecord {
  topicId: string;
  usedAt: string;
  batchId: string;
  youtubeVideoId?: string;
}

export interface PipelineState {
  lastBatchId?: string;
  lastBatchAt?: string;
  topicUsage: TopicUsageRecord[];
  dailyCostUsd: number;
  dailyCostResetDate: string;
  totalVideosProduced: number;
}
