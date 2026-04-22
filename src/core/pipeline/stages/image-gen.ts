/**
 * Image generation stage — calls OpenAI Image API (gpt-image-1) for each scene.
 * Saves images to data/media/<runId>/images/ and returns scene → path mapping.
 */

import { createLogger } from '../../shared/logger.js';
import { PipelineError } from '../../shared/errors.js';
import { PATHS } from '../../shared/constants.js';
import type { PipelineRun, DirectorPlan, ImageGenResult } from '../types.js';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const log = createLogger('pipeline:image-gen');

const IMAGE_MODEL = 'gpt-image-1';
const IMAGE_SIZE = '1024x1792'; // 9:16 portrait
const OUTPUT_FORMAT = 'png';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getReviewedPlan(checkpoint: Record<string, unknown>): DirectorPlan {
  const reviewOutput = checkpoint['review'] as { plan?: DirectorPlan } | undefined;
  const directionOutput = checkpoint['direction'] as { plan?: DirectorPlan } | undefined;
  const plan = reviewOutput?.plan ?? directionOutput?.plan;
  if (!plan) {
    throw new PipelineError(
      'No approved director plan in checkpoint',
      'pipeline_imagegen_no_plan',
    );
  }
  return plan;
}

async function generateSceneImage(
  prompt: string,
  apiKey: string,
): Promise<Buffer> {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      n: 1,
      size: IMAGE_SIZE,
      output_format: OUTPUT_FORMAT,
      quality: 'high',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PipelineError(
      `OpenAI image API error: ${response.status} ${body.slice(0, 200)}`,
      'pipeline_imagegen_api_error',
      { status: response.status },
    );
  }

  const json = (await response.json()) as {
    data: Array<{ b64_json?: string; url?: string }>;
  };

  const item = json.data[0];
  if (!item) {
    throw new PipelineError('Image API returned empty data', 'pipeline_imagegen_empty');
  }

  if (item.b64_json) {
    return Buffer.from(item.b64_json, 'base64');
  }

  if (item.url) {
    const imgResponse = await fetch(item.url);
    if (!imgResponse.ok) {
      throw new PipelineError(
        `Failed to download image from URL: ${imgResponse.status}`,
        'pipeline_imagegen_download_error',
      );
    }
    return Buffer.from(await imgResponse.arrayBuffer());
  }

  throw new PipelineError('Image API returned no b64_json or url', 'pipeline_imagegen_invalid');
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export async function runImageGen(
  run: PipelineRun,
  checkpoint: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  log.info({ runId: run.id }, 'Image generation stage start');

  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new PipelineError('OPENAI_API_KEY not set', 'pipeline_imagegen_no_key');
  }

  const plan = getReviewedPlan(checkpoint);
  const outputDir = path.resolve(PATHS.MEDIA, run.id, 'images');

  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    throw new PipelineError(
      `Cannot create image output dir: ${String(err)}`,
      'pipeline_imagegen_fs_error',
    );
  }

  const scenePaths: Record<number, string> = {};
  let totalCost = 0;

  for (const scene of plan.scenes) {
    const prompt = scene.dalleImagePrompt ?? scene.description;
    if (!prompt || prompt.trim().length === 0) {
      log.warn({ runId: run.id, sceneIndex: scene.index }, 'Scene has no image prompt — skipping');
      continue;
    }

    log.debug({ runId: run.id, sceneIndex: scene.index }, 'Generating scene image');

    try {
      const imageBuffer = await generateSceneImage(prompt, apiKey);
      const filePath = path.join(outputDir, `scene_${scene.index}.png`);
      writeFileSync(filePath, imageBuffer);
      scenePaths[scene.index] = filePath;
      totalCost += 0.04; // gpt-image-1 high quality estimated cost per image
      log.debug({ runId: run.id, sceneIndex: scene.index, filePath }, 'Scene image saved');
    } catch (err) {
      if (err instanceof PipelineError) throw err;
      throw new PipelineError(
        `Image gen failed for scene ${scene.index}: ${String(err)}`,
        'pipeline_imagegen_scene_error',
        { sceneIndex: scene.index },
      );
    }
  }

  const result: ImageGenResult = { scenePaths };
  log.info(
    { runId: run.id, sceneCount: Object.keys(scenePaths).length, totalCost },
    'Image generation stage complete',
  );

  return { imageGen: result, costUsd: totalCost };
}
