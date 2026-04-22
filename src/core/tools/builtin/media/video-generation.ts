/**
 * Upgrade 62: Video Generation Skeleton (Sora-like)
 *
 * In-memory job queue for AI video generation requests.  The status lifecycle
 * is: queued → generating → completed | failed.
 *
 * Integration point: wire completeVideo / failVideo to real provider webhooks
 * (e.g. Runway ML, Luma Dream Machine, Kling) when API keys are available.
 */

import { createLogger } from '../../../shared/logger.js';

const log = createLogger('tool:video-gen');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VideoStatus = 'queued' | 'generating' | 'completed' | 'failed';

export interface VideoRequest {
  prompt: string;
  /** Clip duration in seconds (default: 10) */
  duration?: number;
  /** Visual style hint passed to the provider, e.g. "cinematic", "anime" */
  style?: string;
  resolution?: '720p' | '1080p' | '4k';
}

export interface VideoResult {
  id: string;
  status: VideoStatus;
  prompt: string;
  duration: number;
  style?: string;
  resolution: '720p' | '1080p' | '4k';
  url?: string;
  thumbnailUrl?: string;
  failedReason?: string;
  createdAt: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DURATION_SECONDS = 10;
const DEFAULT_RESOLUTION: VideoResult['resolution'] = '1080p';
const VALID_RESOLUTIONS = new Set<string>(['720p', '1080p', '4k']);

// ---------------------------------------------------------------------------
// In-memory job store
// ---------------------------------------------------------------------------

const videoJobs: Map<string, VideoResult> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue a new video generation request.
 *
 * @param req  Request parameters including prompt and optional settings.
 * @returns    The newly created VideoResult in 'queued' status.
 */
export function requestVideo(req: VideoRequest): VideoResult {
  if (!req?.prompt?.trim()) throw new Error('Video prompt must not be empty');

  const duration = typeof req.duration === 'number' && req.duration > 0
    ? Math.min(req.duration, 300) // cap at 5 minutes
    : DEFAULT_DURATION_SECONDS;

  const resolution: VideoResult['resolution'] =
    req.resolution && VALID_RESOLUTIONS.has(req.resolution)
      ? req.resolution
      : DEFAULT_RESOLUTION;

  const result: VideoResult = {
    id: `video-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    status: 'queued',
    prompt: req.prompt.trim(),
    duration,
    style: req.style?.trim(),
    resolution,
    createdAt: new Date().toISOString(),
  };

  videoJobs.set(result.id, result);
  log.info(
    { id: result.id, duration, resolution, prompt: result.prompt.substring(0, 60) },
    'Video generation queued',
  );

  return result;
}

/**
 * Transition a job to 'generating' status (call when the provider accepts the job).
 */
export function startVideoGeneration(id: string): void {
  const v = videoJobs.get(id);
  if (!v) { log.warn({ id }, 'startVideoGeneration: job not found'); return; }
  if (v.status !== 'queued') { log.warn({ id, status: v.status }, 'Job not in queued state'); return; }

  v.status = 'generating';
  log.info({ id }, 'Video generation started');
}

/**
 * Mark a job as completed and store the delivery URL.
 *
 * @param id           Job ID.
 * @param url          Public URL to the generated video file.
 * @param thumbnailUrl Optional URL to a preview thumbnail.
 */
export function completeVideo(id: string, url: string, thumbnailUrl?: string): void {
  const v = videoJobs.get(id);
  if (!v) { log.warn({ id }, 'completeVideo: job not found'); return; }

  if (!url?.trim()) { log.warn({ id }, 'completeVideo: empty URL ignored'); return; }

  v.status = 'completed';
  v.url = url.trim();
  v.thumbnailUrl = thumbnailUrl?.trim();
  v.completedAt = new Date().toISOString();

  log.info({ id, url: v.url }, 'Video generation completed');
}

/**
 * Mark a job as failed with a reason string.
 */
export function failVideo(id: string, reason: string): void {
  const v = videoJobs.get(id);
  if (!v) { log.warn({ id }, 'failVideo: job not found'); return; }

  v.status = 'failed';
  v.failedReason = reason;
  v.completedAt = new Date().toISOString();

  log.warn({ id, reason }, 'Video generation failed');
}

/**
 * Retrieve a job by ID.  Returns undefined when not found.
 */
export function getVideoStatus(id: string): VideoResult | undefined {
  return videoJobs.get(id);
}

/**
 * Return all video jobs (sorted newest first).
 */
export function listVideos(): VideoResult[] {
  return Array.from(videoJobs.values()).sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt),
  );
}
