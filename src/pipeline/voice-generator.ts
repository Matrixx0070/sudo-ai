/**
 * @file voice-generator.ts
 * Generates TTS narration audio for a video script using the xAI TTS API
 * (rex voice). Produces a single MP3 file and per-scene timestamp offsets
 * computed from proportional word-count distribution.
 */

import { createLogger } from '../core/shared/logger.js';
import { PipelineError } from '../core/shared/errors.js';
import { PATHS } from '../core/shared/constants.js';
import { retry } from '../core/shared/utils.js';
import type {
  GeneratedScript,
  GeneratedVoice,
  SceneTimestamp,
  SceneScript,
} from './types.js';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const log = createLogger('pipeline:voice-generator');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TTS_URL = 'https://api.x.ai/v1/audio/speech';
const TTS_MODEL = 'tts-1';
const TTS_VOICE = 'rex';
const TTS_SPEED = 1.05;
const TTS_FORMAT = 'mp3';

/** Words per minute at 1.0x speed; multiply by speed for effective rate. */
const WPM_BASE = 150;
/** Effective words per minute at TTS_SPEED. */
const WPM_EFFECTIVE = WPM_BASE * TTS_SPEED;

const PAUSE_MARKER = ' ... ';
const COST_PER_CALL_USD = 0.003;
/** Approximate silence inserted between consecutive scenes, in seconds. */
const INTER_SCENE_PAUSE_S = 0.5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a single narration script from all scenes, joined by pause markers.
 */
function buildNarrationText(scenes: SceneScript[]): string {
  return narratedScenes(scenes)
    .map((s) => s.narration.trim())
    .join(PAUSE_MARKER);
}

/**
 * Return only the scenes that contribute spoken narration (non-empty after
 * trimming). These are the scenes actually present in the narration string,
 * so duration estimation and timestamp computation must use the same set to
 * stay consistent.
 */
function narratedScenes(scenes: SceneScript[]): SceneScript[] {
  return scenes.filter((s) => s.narration.trim().length > 0);
}

/**
 * Count whitespace-delimited words in a string.
 */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Estimate total audio duration in seconds given script text.
 * Adds a small buffer per pause marker to account for silence.
 */
function estimateTotalDuration(fullScript: string, sceneCount: number): number {
  const words = wordCount(fullScript);
  const speechSeconds = (words / WPM_EFFECTIVE) * 60;
  const pauseSeconds = Math.max(0, sceneCount - 1) * INTER_SCENE_PAUSE_S;
  return Math.ceil(speechSeconds + pauseSeconds);
}

/**
 * Calculate per-scene start/end timestamps by distributing total duration
 * proportionally to each scene's word count.
 *
 * @param scenes         - Ordered list of scenes.
 * @param totalDurationS - Estimated total audio duration in seconds.
 * @returns Array of SceneTimestamp, one per scene.
 */
function computeTimestamps(
  scenes: SceneScript[],
  totalDurationS: number,
): SceneTimestamp[] {
  const wordCounts = scenes.map((s) => wordCount(s.narration));
  const totalWords = wordCounts.reduce((acc, n) => acc + n, 0) || 1;

  // totalDurationS already includes the inter-scene pause budget (see
  // estimateTotalDuration), so distribute only the speech portion across
  // scenes by word count and account for the pauses explicitly. This keeps
  // the final endSeconds equal to totalDurationS rather than overshooting it.
  const pauseSeconds = Math.max(0, scenes.length - 1) * INTER_SCENE_PAUSE_S;
  const speechSeconds = Math.max(0, totalDurationS - pauseSeconds);

  const timestamps: SceneTimestamp[] = [];
  let cursor = 0;

  for (let i = 0; i < scenes.length; i++) {
    const fraction = (wordCounts[i] ?? 0) / totalWords;
    const sceneDuration = fraction * speechSeconds;
    const start = parseFloat(cursor.toFixed(3));
    const end = parseFloat((cursor + sceneDuration).toFixed(3));
    timestamps.push({ sceneIndex: scenes[i]!.index, startSeconds: start, endSeconds: end });
    cursor += sceneDuration;
    // Add the inter-scene pause gap to cursor for all except the last scene.
    if (i < scenes.length - 1) cursor += INTER_SCENE_PAUSE_S;
  }

  return timestamps;
}

/**
 * POST to the xAI TTS endpoint and return raw audio bytes.
 */
async function callTTS(text: string, apiKey: string): Promise<Buffer> {
  const response = await fetch(TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: text,
      voice: TTS_VOICE,
      response_format: TTS_FORMAT,
      speed: TTS_SPEED,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new PipelineError(
      `xAI TTS API error: ${response.status} ${body.slice(0, 200)}`,
      'pipeline_voice_api_error',
      { status: response.status },
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a single TTS narration track for the entire script.
 * Saves the audio to data/media/<videoId>/audio/narration.mp3 and returns
 * per-scene timestamp breakdowns for downstream assembly.
 *
 * @param script - The fully-generated video script.
 * @returns GeneratedVoice with audio path, duration, timestamps, and cost.
 * @throws PipelineError on missing API key, empty narration, FS errors, or TTS failure.
 */
export async function generateVoice(script: GeneratedScript): Promise<GeneratedVoice> {
  // --- Input validation ---
  if (!script || !script.topic?.entry?.id) {
    throw new PipelineError(
      'generateVoice: script or script.topic.entry.id is missing',
      'pipeline_voice_api_error',
    );
  }
  if (!Array.isArray(script.scenes) || script.scenes.length === 0) {
    throw new PipelineError(
      'generateVoice: script.scenes must be a non-empty array',
      'pipeline_voice_api_error',
    );
  }

  const apiKey = process.env['XAI_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new PipelineError(
      'No API key found for TTS — set XAI_API_KEY or OPENAI_API_KEY',
      'pipeline_voice_api_error',
    );
  }

  const videoId = script.topic.entry.id;
  const narrationText = buildNarrationText(script.scenes);

  if (narrationText.trim().length === 0) {
    throw new PipelineError(
      'generateVoice: all scene narration lines are empty',
      'pipeline_voice_api_error',
    );
  }

  log.info(
    { videoId, sceneCount: script.scenes.length, scriptLength: narrationText.length },
    'Voice generation start',
  );

  // --- Prepare output directory ---
  const outputDir = path.resolve(PATHS.MEDIA, videoId, 'audio');
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    throw new PipelineError(
      `Cannot create audio output directory: ${String(err)}`,
      'pipeline_voice_api_error',
      { outputDir },
    );
  }

  // --- Call TTS with retry ---
  let audioBuffer: Buffer;
  try {
    audioBuffer = await retry(
      () => callTTS(narrationText, apiKey),
      3,
      [1_000, 2_000, 4_000],
    );
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      `TTS call failed: ${String(err)}`,
      'pipeline_voice_api_error',
    );
  }

  // --- Save audio file ---
  const audioPath = path.join(outputDir, 'narration.mp3');
  writeFileSync(audioPath, audioBuffer);
  log.debug({ audioPath, bufferBytes: audioBuffer.length }, 'Audio file saved');

  // --- Compute duration and per-scene timestamps ---
  // Use the same scene set that produced the narration (non-empty narration
  // only) so the modeled pause count matches the pauses actually spoken and
  // the per-scene cursor advancement.
  const spokenScenes = narratedScenes(script.scenes);
  const durationSeconds = estimateTotalDuration(narrationText, spokenScenes.length);
  const sceneTimestamps = computeTimestamps(spokenScenes, durationSeconds);

  log.info(
    { videoId, audioPath, durationSeconds, sceneCount: sceneTimestamps.length },
    'Voice generation complete',
  );

  return {
    audioPath,
    durationSeconds,
    sceneTimestamps,
    costUsd: COST_PER_CALL_USD,
  };
}
