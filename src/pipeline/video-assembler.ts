/**
 * @file video-assembler.ts
 * Assembles a final 1080x1920 MP4 from scene images + voice audio using ffmpeg.
 * Delegates filter_complex construction to assembler-filters.ts.
 * Applies Ken Burns zoom, subtitle burn-in, then extracts a thumbnail at 2 s.
 */

import { createLogger } from '../core/shared/logger.js';
import { PipelineError } from '../core/shared/errors.js';
import { PATHS } from '../core/shared/constants.js';
import { buildFilterComplex, OUTPUT_WIDTH, OUTPUT_HEIGHT, OUTPUT_FPS } from './assembler-filters.js';
import type {
  GeneratedScript,
  RenderedScenes,
  GeneratedVoice,
  AssembledVideo,
  SceneAssets,
} from './types.js';
import { spawn } from 'child_process';
import { mkdirSync, statSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

const log = createLogger('pipeline:video-assembler');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTPUT_CODEC = 'libx264';
const AUDIO_CODEC = 'aac';
const AUDIO_BITRATE = '192k';
const CRF = '23';
const PRESET = 'fast';

// ---------------------------------------------------------------------------
// ffmpeg spawn wrapper
// ---------------------------------------------------------------------------

/**
 * Run ffmpeg with the given arguments.
 * Collects stderr; resolves on exit code 0, rejects with PipelineError otherwise.
 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    log.debug({ cmd: ['ffmpeg', ...args].join(' ').slice(0, 300) }, 'Running ffmpeg');
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(
          new PipelineError(
            `ffmpeg exited with code ${String(code)}: ${stderr.slice(-600)}`,
            'pipeline_assembly_ffmpeg_error',
            { code, stderrTail: stderr.slice(-600) },
          ),
        );
      } else {
        resolve();
      }
    });

    proc.on('error', (err) => {
      reject(
        new PipelineError(
          `ffmpeg spawn error: ${err.message}`,
          'pipeline_assembly_ffmpeg_error',
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble a final YouTube Shorts-ready MP4 from rendered images and voice audio.
 * Steps:
 *  1. Validate inputs.
 *  2. Build ffmpeg filter_complex (Ken Burns + concat + subtitles + audio mix).
 *  3. Run main ffmpeg encode.
 *  4. Extract thumbnail at 2 s.
 *  5. Stat file size, clean up temp dir.
 *
 * @param script - Generated script (title, scenes with narration text).
 * @param scenes - Rendered scene assets (image file paths per scene).
 * @param voice  - Generated voice (audio path, duration, per-scene timestamps).
 * @returns AssembledVideo with paths, size, duration, and resolution.
 * @throws PipelineError on invalid inputs or any ffmpeg failure.
 */
export async function assembleVideo(
  script: GeneratedScript,
  scenes: RenderedScenes,
  voice: GeneratedVoice,
): Promise<AssembledVideo> {
  // --- Input validation ---
  if (!script?.topic?.entry?.id) {
    throw new PipelineError(
      'assembleVideo: script.topic.entry.id is missing',
      'pipeline_assembly_ffmpeg_error',
    );
  }
  if (!scenes?.assets || scenes.assets.length === 0) {
    throw new PipelineError(
      'assembleVideo: scenes.assets is empty',
      'pipeline_assembly_ffmpeg_error',
    );
  }
  if (!voice?.audioPath) {
    throw new PipelineError(
      'assembleVideo: voice.audioPath is missing',
      'pipeline_assembly_ffmpeg_error',
    );
  }
  if (voice.durationSeconds <= 0) {
    throw new PipelineError(
      'assembleVideo: voice.durationSeconds must be positive',
      'pipeline_assembly_ffmpeg_error',
    );
  }

  const videoId = script.topic.entry.id;
  const outputDir = path.resolve(PATHS.MEDIA, videoId, 'final');
  const tmpDir = path.join(os.tmpdir(), `sudoai_batch_${videoId}`);

  log.info({ videoId, outputDir }, 'Video assembly start');

  try {
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    throw new PipelineError(
      `Cannot create output directories: ${String(err)}`,
      'pipeline_assembly_ffmpeg_error',
      { outputDir, tmpDir },
    );
  }

  // Filter to scenes with a confirmed image file path
  const validAssets = scenes.assets.filter(
    (a): a is SceneAssets & { imagePath: string } =>
      typeof a.imagePath === 'string' && a.imagePath.length > 0,
  );

  if (validAssets.length === 0) {
    throw new PipelineError(
      'assembleVideo: no valid scene image paths found in RenderedScenes',
      'pipeline_assembly_ffmpeg_error',
    );
  }

  // --- Build ffmpeg args ---
  // Input ordering: image0..imageN, voice_audio
  const ffmpegArgs: string[] = ['-y'];
  for (const asset of validAssets) {
    ffmpegArgs.push('-loop', '1', '-i', asset.imagePath);
  }
  const voiceInputIndex = validAssets.length;
  ffmpegArgs.push('-i', voice.audioPath);

  const filterComplex = buildFilterComplex(
    validAssets,
    voice.sceneTimestamps,
    script.scenes,
    voiceInputIndex,
  );

  log.debug({ videoId, filterSnippet: filterComplex.slice(0, 400) }, 'filter_complex ready');

  const finalVideoPath = path.join(outputDir, `${videoId}_final.mp4`);

  ffmpegArgs.push(
    '-filter_complex', filterComplex,
    '-map', '[vid]',
    '-map', '[aout]',
    '-c:v', OUTPUT_CODEC,
    '-preset', PRESET,
    '-crf', CRF,
    '-c:a', AUDIO_CODEC,
    '-b:a', AUDIO_BITRATE,
    '-r', String(OUTPUT_FPS),
    '-t', String(voice.durationSeconds),
    '-movflags', '+faststart',
    '-pix_fmt', 'yuv420p',
    finalVideoPath,
  );

  try {
    await runFfmpeg(ffmpegArgs);
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      `Video assembly ffmpeg failed: ${String(err)}`,
      'pipeline_assembly_ffmpeg_error',
    );
  }

  log.debug({ videoId }, 'Main encode complete — extracting thumbnail');

  // --- Thumbnail at 2 s ---
  const thumbnailPath = path.join(outputDir, `${videoId}_thumb.jpg`);
  try {
    await runFfmpeg([
      '-y', '-ss', '2',
      '-i', finalVideoPath,
      '-vframes', '1',
      '-q:v', '2',
      thumbnailPath,
    ]);
  } catch (err) {
    log.warn({ videoId, err: String(err) }, 'Thumbnail extraction failed — continuing without it');
  }

  // --- File stats ---
  let fileSizeBytes = 0;
  try {
    fileSizeBytes = statSync(finalVideoPath).size;
  } catch (err) {
    log.warn({ videoId, err: String(err) }, 'Could not stat final video file');
  }

  // --- Cleanup temp dir ---
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    log.warn({ tmpDir, err: String(err) }, 'Temp dir cleanup failed — non-fatal');
  }

  const result: AssembledVideo = {
    videoPath: finalVideoPath,
    thumbnailPath,
    durationSeconds: voice.durationSeconds,
    fileSizeBytes,
    resolution: { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT },
    costUsd: 0,
  };

  log.info(
    { videoId, finalVideoPath, fileSizeBytes, durationSeconds: voice.durationSeconds },
    'Video assembly complete',
  );

  return result;
}
