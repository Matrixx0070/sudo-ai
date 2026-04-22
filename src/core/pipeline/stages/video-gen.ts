/**
 * Video generation stage — animates each scene image into a 6s clip using
 * Grok Imagine image-to-video API with last-frame chaining.
 */

import { createLogger } from '../../shared/logger.js';
import { PipelineError } from '../../shared/errors.js';
import { PATHS } from '../../shared/constants.js';
import type { PipelineRun, DirectorPlan, ImageGenResult, VideoGenResult } from '../types.js';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';

const log = createLogger('pipeline:video-gen');

// xAI video generation API is not yet publicly available.
// Set SUDO_AI_VIDEO_GEN_ENABLED=true in the environment to attempt real API calls.
// Until then the stage logs a warning and passes image paths through unchanged.
const VIDEO_GEN_ENABLED =
  (process.env['SUDO_AI_VIDEO_GEN_ENABLED'] ?? 'false').toLowerCase() === 'true';

const GROK_VIDEO_MODEL = 'grok-2-vision-1212'; // update when video-gen API ships
const CLIP_DURATION_SECONDS = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getReviewedPlan(checkpoint: Record<string, unknown>): DirectorPlan {
  const reviewOutput = checkpoint['review'] as { plan?: DirectorPlan } | undefined;
  const directionOutput = checkpoint['direction'] as { plan?: DirectorPlan } | undefined;
  const plan = reviewOutput?.plan ?? directionOutput?.plan;
  if (!plan) {
    throw new PipelineError('No director plan in checkpoint', 'pipeline_videogen_no_plan');
  }
  return plan;
}

function getImagePaths(checkpoint: Record<string, unknown>): Record<number, string> {
  const imgOut = checkpoint['image_gen'] as { imageGen?: ImageGenResult } | undefined;
  if (!imgOut?.imageGen?.scenePaths) {
    throw new PipelineError(
      'Image gen checkpoint missing — run image_gen stage first',
      'pipeline_videogen_no_images',
    );
  }
  return imgOut.imageGen.scenePaths;
}

async function generateClip(
  imageBuffer: Buffer,
  videoPrompt: string,
  apiKey: string,
  runId: string,
  sceneIndex: number,
): Promise<Buffer> {
  // Encode reference image as base64.
  const imageBase64 = imageBuffer.toString('base64');

  const response = await fetch('https://api.x.ai/v1/video/generate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROK_VIDEO_MODEL,
      image: imageBase64,
      prompt: videoPrompt,
      duration_seconds: CLIP_DURATION_SECONDS,
      aspect_ratio: '9:16',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PipelineError(
      `Grok video API error for scene ${sceneIndex}: ${response.status} ${body.slice(0, 200)}`,
      'pipeline_videogen_api_error',
      { status: response.status, runId, sceneIndex },
    );
  }

  const json = (await response.json()) as {
    data?: Array<{ b64_video?: string; url?: string }>;
    video?: { b64?: string; url?: string };
  };

  // Handle different response shapes.
  const b64 = json.data?.[0]?.b64_video ?? json.video?.b64;
  const url = json.data?.[0]?.url ?? json.video?.url;

  if (b64) {
    return Buffer.from(b64, 'base64');
  }
  if (url) {
    const dl = await fetch(url);
    if (!dl.ok) {
      throw new PipelineError(
        `Failed to download video clip: ${dl.status}`,
        'pipeline_videogen_download_error',
        { sceneIndex },
      );
    }
    return Buffer.from(await dl.arrayBuffer());
  }

  throw new PipelineError(
    `Grok video API returned no data for scene ${sceneIndex}`,
    'pipeline_videogen_empty',
    { sceneIndex },
  );
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export async function runVideoGen(
  run: PipelineRun,
  checkpoint: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  log.info({ runId: run.id }, 'Video generation stage start');

  // ------------------------------------------------------------------
  // Early-exit: video generation API is not yet available.
  // Return image paths unchanged so the pipeline continues uninterrupted.
  // ------------------------------------------------------------------
  if (!VIDEO_GEN_ENABLED) {
    log.warn(
      { runId: run.id },
      'Video generation API not yet available — skipping stage. ' +
      'Set SUDO_AI_VIDEO_GEN_ENABLED=true to enable when the API ships.',
    );
    const imagePaths = getImagePaths(checkpoint);
    const passthrough: VideoGenResult = { clipPaths: imagePaths };
    return { videoGen: passthrough, costUsd: 0 };
  }

  const apiKey = process.env['XAI_API_KEY'];
  if (!apiKey) {
    throw new PipelineError('XAI_API_KEY not set', 'pipeline_videogen_no_key');
  }

  const plan = getReviewedPlan(checkpoint);
  const imagePaths = getImagePaths(checkpoint);

  const outputDir = path.resolve(PATHS.MEDIA, run.id, 'clips');
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    throw new PipelineError(
      `Cannot create clip output dir: ${String(err)}`,
      'pipeline_videogen_fs_error',
    );
  }

  const clipPaths: Record<number, string> = {};
  let totalCost = 0;
  let lastFramePath: string | null = null;

  for (const scene of plan.scenes) {
    const imagePath = imagePaths[scene.index];
    if (!imagePath) {
      log.warn({ runId: run.id, sceneIndex: scene.index }, 'No image found for scene — skipping video gen');
      continue;
    }

    // Last-frame chaining: use previous clip's last frame as reference when available.
    const refImagePath = lastFramePath ?? imagePath;
    const videoPrompt = scene.grokVideoPrompt ?? `${scene.description} face identity preserved`;

    log.debug({ runId: run.id, sceneIndex: scene.index }, 'Generating video clip');

    try {
      const imageBuffer = readFileSync(refImagePath);
      const clipBuffer = await generateClip(imageBuffer, videoPrompt, apiKey, run.id, scene.index);

      const clipPath = path.join(outputDir, `clip_${scene.index}.mp4`);
      writeFileSync(clipPath, clipBuffer);
      clipPaths[scene.index] = clipPath;
      lastFramePath = clipPath; // Chain to next scene.
      totalCost += 0.1; // Estimated Grok video cost per clip.
      log.debug({ runId: run.id, sceneIndex: scene.index, clipPath }, 'Clip saved');
    } catch (err) {
      if (err instanceof PipelineError) throw err;
      throw new PipelineError(
        `Video gen failed for scene ${scene.index}: ${String(err)}`,
        'pipeline_videogen_scene_error',
        { sceneIndex: scene.index },
      );
    }
  }

  const result: VideoGenResult = { clipPaths };
  log.info(
    { runId: run.id, clipCount: Object.keys(clipPaths).length, totalCost },
    'Video generation stage complete',
  );

  return { videoGen: result, costUsd: totalCost };
}
