/**
 * Assembly stage — uses ffmpeg to composite video clips, voice, music, SFX,
 * and burn-in subtitles into a final 9:16 Shorts-ready MP4.
 */

import { createLogger } from '../../shared/logger.js';
import { PipelineError } from '../../shared/errors.js';
import { PATHS } from '../../shared/constants.js';
import type {
  PipelineRun,
  DirectorPlan,
  VideoGenResult,
  VoiceResult,
  MusicResult,
  SfxResult,
  AssemblyResult,
} from '../types.js';
import { mkdirSync, writeFileSync, statSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

const log = createLogger('pipeline:assembly');

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;
const OUTPUT_CODEC = 'libx264';
const AUDIO_CODEC = 'aac';
const MUSIC_VOLUME = 0.15; // Background music ducked under voice

// ---------------------------------------------------------------------------
// Helpers — checkpoint accessors
// ---------------------------------------------------------------------------

function requirePlan(checkpoint: Record<string, unknown>): DirectorPlan {
  const r = checkpoint['review'] as { plan?: DirectorPlan } | undefined;
  const d = checkpoint['direction'] as { plan?: DirectorPlan } | undefined;
  const plan = r?.plan ?? d?.plan;
  if (!plan) throw new PipelineError('No director plan in checkpoint', 'pipeline_assembly_no_plan');
  return plan;
}

function requireVideoGen(checkpoint: Record<string, unknown>): VideoGenResult {
  const v = checkpoint['video_gen'] as { videoGen?: VideoGenResult } | undefined;
  if (!v?.videoGen) {
    throw new PipelineError('No video gen data in checkpoint', 'pipeline_assembly_no_clips');
  }
  return v.videoGen;
}

function getVoice(checkpoint: Record<string, unknown>): VoiceResult | null {
  const v = checkpoint['voice'] as { voice?: VoiceResult } | undefined;
  return v?.voice ?? null;
}

function getMusic(checkpoint: Record<string, unknown>): MusicResult | null {
  const m = checkpoint['music'] as { music?: MusicResult } | undefined;
  return m?.music ?? null;
}

function getSfx(checkpoint: Record<string, unknown>): SfxResult | null {
  const s = checkpoint['sfx'] as { sfx?: SfxResult } | undefined;
  return s?.sfx ?? null;
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    log.debug({ args: args.join(' ') }, 'Running ffmpeg');
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(
          new PipelineError(
            `ffmpeg exited with code ${String(code)}: ${stderr.slice(-500)}`,
            'pipeline_assembly_ffmpeg_error',
            { code, stderrTail: stderr.slice(-500) },
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
          'pipeline_assembly_ffmpeg_spawn',
        ),
      );
    });
  });
}

function buildConcatFile(clipPaths: Record<number, string>, tmpDir: string): string {
  const sortedClips = Object.entries(clipPaths)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, p]) => p);

  const content = sortedClips.map((p) => `file '${p}'`).join('\n');
  const concatFile = path.join(tmpDir, 'concat.txt');
  writeFileSync(concatFile, content);
  return concatFile;
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export async function runAssembly(
  run: PipelineRun,
  checkpoint: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  log.info({ runId: run.id }, 'Assembly stage start');

  const _plan = requirePlan(checkpoint);
  const videoGen = requireVideoGen(checkpoint);
  const voice = getVoice(checkpoint);
  const music = getMusic(checkpoint);
  const sfx = getSfx(checkpoint);

  if (Object.keys(videoGen.clipPaths).length === 0) {
    throw new PipelineError('No video clips available for assembly', 'pipeline_assembly_no_clips');
  }

  const outputDir = path.resolve(PATHS.MEDIA, run.id, 'final');
  const tmpDir = path.join(os.tmpdir(), `sudoai_${run.id}`);
  try {
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    throw new PipelineError(`Cannot create output dirs: ${String(err)}`, 'pipeline_assembly_fs_error');
  }

  // Step 1: Concatenate video clips into raw_video.mp4
  const concatFile = buildConcatFile(videoGen.clipPaths, tmpDir);
  const rawVideoPath = path.join(tmpDir, 'raw_video.mp4');

  await runFfmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatFile,
    '-c', 'copy',
    rawVideoPath,
  ]);

  log.debug({ runId: run.id, rawVideoPath }, 'Clips concatenated');

  // Step 2: Build audio mix args (voice + music + sfx)
  const finalVideoPath = path.join(outputDir, `${run.id}_final.mp4`);
  const ffmpegArgs: string[] = ['-y', '-i', rawVideoPath];
  let audioInputIndex = 1;
  const amixInputs: string[] = [];

  if (voice?.audioPath) {
    ffmpegArgs.push('-i', voice.audioPath);
    amixInputs.push(`[${audioInputIndex}:a]volume=1.0[voice]`);
    audioInputIndex++;
  }

  if (music?.trackPath && music.trackPath.length > 0) {
    ffmpegArgs.push('-i', music.trackPath);
    amixInputs.push(`[${audioInputIndex}:a]volume=${MUSIC_VOLUME}[music]`);
    audioInputIndex++;
  }

  for (const sfxPath of sfx?.sfxPaths ?? []) {
    ffmpegArgs.push('-i', sfxPath);
    amixInputs.push(`[${audioInputIndex}:a]volume=0.5[sfx${audioInputIndex}]`);
    audioInputIndex++;
  }

  // Build filter_complex for video scale + audio mix
  const sfxLabels = (sfx?.sfxPaths ?? []).map((_, i) => `[sfx${i + (voice ? 2 : 1) + (music?.trackPath ? 1 : 0)}]`);
  const audioLabels = [
    ...(voice?.audioPath ? ['[voice]'] : []),
    ...(music?.trackPath && music.trackPath.length > 0 ? ['[music]'] : []),
    ...sfxLabels,
  ];

  const filterParts: string[] = amixInputs;
  filterParts.push(
    `[0:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2[vid]`,
  );

  if (audioLabels.length > 0) {
    filterParts.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=first[aout]`);
  }

  ffmpegArgs.push(
    '-filter_complex', filterParts.join('; '),
    '-map', '[vid]',
    ...(audioLabels.length > 0 ? ['-map', '[aout]'] : []),
    '-c:v', OUTPUT_CODEC,
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', AUDIO_CODEC,
    '-b:a', '192k',
    '-r', String(OUTPUT_FPS),
    '-movflags', '+faststart',
    finalVideoPath,
  );

  await runFfmpeg(ffmpegArgs);

  const stats = statSync(finalVideoPath);
  const fileSizeBytes = stats.size;

  // Estimate duration from clips (6s each).
  const durationSeconds = Object.keys(videoGen.clipPaths).length * 6;

  const result: AssemblyResult = {
    videoPath: finalVideoPath,
    fileSizeBytes,
    durationSeconds,
  };

  log.info(
    { runId: run.id, finalVideoPath, fileSizeBytes, durationSeconds },
    'Assembly stage complete',
  );

  return { assembly: result, costUsd: 0 };
}
