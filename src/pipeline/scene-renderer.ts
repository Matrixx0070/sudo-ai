/**
 * @file scene-renderer.ts
 * Generates scene visual assets by calling the OpenAI gpt-image-1 API.
 * Each scene in the script produces a portrait PNG saved under
 * data/media/<videoId>/images/scene_<n>.png.
 */

import { createLogger } from '../core/shared/logger.js';
import { PipelineError } from '../core/shared/errors.js';
import { PATHS } from '../core/shared/constants.js';
import { retry } from '../core/shared/utils.js';
import type { GeneratedScript, RenderedScenes, SceneAssets, SceneScript } from './types.js';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const log = createLogger('pipeline:scene-renderer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IMAGE_MODEL = 'gpt-image-1';
const IMAGE_SIZE = '1024x1792'; // 9:16 portrait for Shorts
const OUTPUT_FORMAT = 'png';
const COST_PER_IMAGE_USD = 0.04;
const MIN_SUCCESSFUL_SCENES = 6;
const STYLE_SUFFIX = ', dramatic Bollywood style, cinematic lighting, vibrant colors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenAIImageResponse {
  data: Array<{ b64_json?: string; url?: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a combined image prompt for a scene.
 */
function buildImagePrompt(scene: SceneScript): string {
  const parts = [scene.description.trim()];
  if (scene.emotion && scene.emotion.trim().length > 0) {
    parts.push(`mood: ${scene.emotion.trim()}`);
  }
  parts.push(STYLE_SUFFIX);
  return parts.join(' ');
}

/**
 * Call the OpenAI image generation API and return a PNG buffer.
 * Supports both b64_json and URL response formats.
 */
async function fetchSceneImage(prompt: string, apiKey: string): Promise<Buffer> {
  if (!prompt || prompt.trim().length === 0) {
    throw new PipelineError('Image prompt is empty', 'pipeline_render_api_error');
  }

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
      quality: 'standard',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PipelineError(
      `OpenAI image API error: ${response.status} ${body.slice(0, 200)}`,
      'pipeline_render_api_error',
      { status: response.status },
    );
  }

  const json = (await response.json()) as OpenAIImageResponse;
  const item = json.data[0];

  if (!item) {
    throw new PipelineError(
      'OpenAI image API returned empty data array',
      'pipeline_render_api_error',
    );
  }

  if (item.b64_json) {
    return Buffer.from(item.b64_json, 'base64');
  }

  if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) {
      throw new PipelineError(
        `Failed to download image from signed URL: ${imgRes.status}`,
        'pipeline_render_api_error',
        { status: imgRes.status },
      );
    }
    return Buffer.from(await imgRes.arrayBuffer());
  }

  throw new PipelineError(
    'OpenAI image API response contained neither b64_json nor url',
    'pipeline_render_api_error',
  );
}

/**
 * Attempt to generate and save one scene image.
 * Returns the saved file path on success, null on failure (caller decides skip vs abort).
 */
async function renderOneScene(
  scene: SceneScript,
  outputDir: string,
  apiKey: string,
): Promise<string | null> {
  const prompt = buildImagePrompt(scene);
  log.debug({ sceneIndex: scene.index, prompt: prompt.slice(0, 120) }, 'Generating scene image');

  try {
    const buf = await retry(() => fetchSceneImage(prompt, apiKey), 3, [1_000, 2_000, 4_000]);
    const filePath = path.join(outputDir, `scene_${scene.index}.png`);
    writeFileSync(filePath, buf);
    log.debug({ sceneIndex: scene.index, filePath }, 'Scene image saved');
    return filePath;
  } catch (err) {
    log.warn(
      { sceneIndex: scene.index, err: String(err) },
      'Scene image generation failed — will skip this scene',
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render all scenes in a generated script to PNG images.
 * At least MIN_SUCCESSFUL_SCENES (6/8) must succeed; otherwise throws.
 *
 * @param script - The fully-generated video script.
 * @returns RenderedScenes with asset paths, generation method, and cost.
 * @throws PipelineError on API key absence, directory creation failure,
 *         or insufficient scene success rate.
 */
export async function renderScenes(script: GeneratedScript): Promise<RenderedScenes> {
  // --- Input validation ---
  if (!script || !script.topic?.entry?.id) {
    throw new PipelineError(
      'renderScenes: script or script.topic.entry.id is missing',
      'pipeline_render_api_error',
    );
  }
  if (!Array.isArray(script.scenes) || script.scenes.length === 0) {
    throw new PipelineError(
      'renderScenes: script.scenes must be a non-empty array',
      'pipeline_render_api_error',
    );
  }

  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new PipelineError(
      'OPENAI_API_KEY environment variable is not set',
      'pipeline_render_api_error',
    );
  }

  const videoId = script.topic.entry.id;
  const outputDir = path.resolve(PATHS.MEDIA, videoId, 'images');
  log.info({ videoId, sceneCount: script.scenes.length, outputDir }, 'Scene rendering start');

  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    throw new PipelineError(
      `Cannot create image output directory: ${String(err)}`,
      'pipeline_render_api_error',
      { outputDir },
    );
  }

  const assets: SceneAssets[] = [];
  let successCount = 0;
  let costUsd = 0;

  for (const scene of script.scenes) {
    const imagePath = await renderOneScene(scene, outputDir, apiKey);
    if (imagePath !== null) {
      assets.push({ sceneIndex: scene.index, imagePath });
      costUsd += COST_PER_IMAGE_USD;
      successCount++;
    } else {
      // Record asset entry with no path so assembler can skip this scene
      assets.push({ sceneIndex: scene.index });
    }
  }

  if (successCount < MIN_SUCCESSFUL_SCENES) {
    throw new PipelineError(
      `Only ${successCount}/${script.scenes.length} scenes rendered successfully (minimum ${MIN_SUCCESSFUL_SCENES} required)`,
      'pipeline_render_api_error',
      { successCount, totalScenes: script.scenes.length, minRequired: MIN_SUCCESSFUL_SCENES },
    );
  }

  log.info(
    { videoId, successCount, totalScenes: script.scenes.length, costUsd },
    'Scene rendering complete',
  );

  return {
    assets,
    method: 'image-gen',
    costUsd,
  };
}
