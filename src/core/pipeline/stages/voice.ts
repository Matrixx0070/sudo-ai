/**
 * Voice stage — generates TTS narration using xAI TTS (rex voice).
 * Concatenates all scene narration lines into a single audio track.
 */

import { createLogger } from '../../shared/logger.js';
import { PipelineError } from '../../shared/errors.js';
import { PATHS } from '../../shared/constants.js';
import type { PipelineRun, DirectorPlan, VoiceResult } from '../types.js';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const log = createLogger('pipeline:voice');

const TTS_VOICE = 'rex'; // xAI TTS voice
const TTS_MODEL = 'tts-1';
const AUDIO_FORMAT = 'mp3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getReviewedPlan(checkpoint: Record<string, unknown>): DirectorPlan {
  const reviewOutput = checkpoint['review'] as { plan?: DirectorPlan } | undefined;
  const directionOutput = checkpoint['direction'] as { plan?: DirectorPlan } | undefined;
  const plan = reviewOutput?.plan ?? directionOutput?.plan;
  if (!plan) {
    throw new PipelineError('No director plan in checkpoint', 'pipeline_voice_no_plan');
  }
  return plan;
}

function buildNarrationScript(plan: DirectorPlan): string {
  return plan.narration
    .map((line, i) => {
      const cleaned = line
        .replace(/\[pause\]/gi, ' ... ')
        .replace(/<whisper>(.*?)<\/whisper>/gi, '$1')
        .trim();
      return cleaned;
    })
    .filter((line) => line.length > 0)
    .join(' ');
}

async function callTTS(text: string, apiKey: string): Promise<Buffer> {
  if (!text || text.trim().length === 0) {
    throw new PipelineError('TTS input text is empty', 'pipeline_voice_empty_text');
  }

  const response = await fetch('https://api.x.ai/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: text,
      voice: TTS_VOICE,
      response_format: AUDIO_FORMAT,
      speed: 1.05, // Slightly faster for Shorts pacing
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

function estimateDuration(text: string): number {
  // Average speaking rate ~150 words per minute at speed 1.05
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil((words / 150) * 60);
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export async function runVoice(
  run: PipelineRun,
  checkpoint: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  log.info({ runId: run.id }, 'Voice stage start');

  const apiKey = process.env['XAI_API_KEY'] ?? process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new PipelineError('No API key for TTS (XAI_API_KEY or OPENAI_API_KEY)', 'pipeline_voice_no_key');
  }

  const plan = getReviewedPlan(checkpoint);
  const script = buildNarrationScript(plan);

  if (script.trim().length === 0) {
    throw new PipelineError(
      'Narration script is empty after processing',
      'pipeline_voice_empty_script',
    );
  }

  log.debug(
    { runId: run.id, scriptLength: script.length, voice: TTS_VOICE },
    'Generating TTS narration',
  );

  const outputDir = path.resolve(PATHS.MEDIA, run.id, 'audio');
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    throw new PipelineError(
      `Cannot create audio output dir: ${String(err)}`,
      'pipeline_voice_fs_error',
    );
  }

  let audioBuffer: Buffer;
  try {
    audioBuffer = await callTTS(script, apiKey);
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      `TTS call failed: ${String(err)}`,
      'pipeline_voice_api_error',
    );
  }

  const audioPath = path.join(outputDir, 'narration.mp3');
  writeFileSync(audioPath, audioBuffer);

  const durationSeconds = estimateDuration(script);
  const result: VoiceResult = { audioPath, durationSeconds };

  log.info(
    { runId: run.id, audioPath, durationSeconds },
    'Voice stage complete',
  );

  return { voice: result, costUsd: 0.003 };
}
