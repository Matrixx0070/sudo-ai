/**
 * Pipeline type definitions for SUDO-AI v3 video production pipeline.
 * All 10 production stages are modelled here.
 */

// ---------------------------------------------------------------------------
// Stage definitions
// ---------------------------------------------------------------------------

export type PipelineStage =
  | 'research'
  | 'direction'
  | 'review'
  | 'image_gen'
  | 'video_gen'
  | 'voice'
  | 'music'
  | 'sfx'
  | 'assembly'
  | 'quality_gate';

export const PIPELINE_STAGES: readonly PipelineStage[] = [
  'research',
  'direction',
  'review',
  'image_gen',
  'video_gen',
  'voice',
  'music',
  'sfx',
  'assembly',
  'quality_gate',
] as const;

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

export interface PipelineRun {
  id: string;
  taskId: string;
  topic: string;
  stage: PipelineStage;
  stageIndex: number;
  checkpoint: Record<string, unknown>;
  directorPlan?: DirectorPlan;
  youtubeId?: string;
  totalCost: number;
  status: 'running' | 'paused' | 'done' | 'failed';
  createdAt: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Director plan
// ---------------------------------------------------------------------------

export interface DirectorPlan {
  title: string;
  scenes: ScenePlan[];
  cast: Record<string, CharacterDNA>;
  narration: string[];
  hookLine: string;
  ctaQuestion: string;
}

export interface ScenePlan {
  index: number;
  description: string;
  location: string;
  charactersInScene: string[];
  cameraAngle: string;
  narrationLine: string;
  emotionalBeat: string;
  dalleImagePrompt?: string;
  grokVideoPrompt?: string;
  textOverlay?: string;
}

export interface CharacterDNA {
  name: string;
  role: 'protagonist' | 'antagonist' | 'supporting';
  appearance: string;
  outfit: string;
}

// ---------------------------------------------------------------------------
// Quality gate
// ---------------------------------------------------------------------------

export interface QualityCheck {
  name: string;
  passed: boolean;
  actual: string;
  expected: string;
}

export interface QualityReport {
  passed: boolean;
  checks: QualityCheck[];
}

// ---------------------------------------------------------------------------
// Stage I/O types
// ---------------------------------------------------------------------------

export interface ResearchData {
  facts: string[];
  summary: string;
  sources: string[];
}

export interface ImageGenResult {
  scenePaths: Record<number, string>;
}

export interface VideoGenResult {
  clipPaths: Record<number, string>;
}

export interface VoiceResult {
  audioPath: string;
  durationSeconds: number;
}

export interface MusicResult {
  trackPath: string;
  mood: string;
}

export interface SfxResult {
  sfxPaths: string[];
  preset: string;
}

export interface AssemblyResult {
  videoPath: string;
  fileSizeBytes: number;
  durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

export interface PipelineRunOptions {
  resumeFromRunId?: string;
  skipStages?: PipelineStage[];
  dryRun?: boolean;
  maxCostUsd?: number;
}
