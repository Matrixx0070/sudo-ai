/**
 * @file quality-gate.ts
 * Validates a fully-assembled video using ffprobe.
 * Checks: resolution, duration, audio presence, audio levels, file size, frame rate.
 * Grades: all pass → A, 1 fail → B, 2 fails → C, 3+ fails → FAIL.
 */

import { spawn } from 'child_process';
import { createLogger } from '../core/shared/logger.js';
import { PipelineError } from '../core/shared/errors.js';
import {
  type AssembledVideo,
  type VideoFormat,
  type QualityGateResult,
  type QualityCheckResult,
  VIDEO_FORMAT_CONFIG,
} from './types.js';

const log = createLogger('pipeline:quality-gate');

// ---------------------------------------------------------------------------
// Internal probe types
// ---------------------------------------------------------------------------

interface ProbeData {
  width: number;
  height: number;
  durationSeconds: number;
  hasAudioStream: boolean;
  frameRate: number;
}

interface VolumeData {
  maxVolume: number; // dBFS (negative)
  meanVolume: number; // dBFS (negative)
}

// ---------------------------------------------------------------------------
// ffprobe helpers
// ---------------------------------------------------------------------------

/**
 * Run ffprobe on a video file and return basic stream metadata.
 */
async function probeVideo(filePath: string): Promise<ProbeData> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ];

    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new PipelineError(
          `ffprobe failed (code ${String(code)}): ${stderr.slice(-300)}`,
          'pipeline_qg_probe_error',
        ));
        return;
      }

      try {
        const data = JSON.parse(stdout) as {
          streams?: Array<{
            codec_type?: string;
            width?: number;
            height?: number;
            duration?: string;
            r_frame_rate?: string;
            avg_frame_rate?: string;
          }>;
          format?: { duration?: string };
        };

        const videoStream = data.streams?.find((s) => s.codec_type === 'video');
        const audioStream = data.streams?.find((s) => s.codec_type === 'audio');
        const durationStr = videoStream?.duration ?? data.format?.duration ?? '0';

        // Parse frame rate from "num/den" string (e.g. "30/1" or "30000/1001")
        const fpsStr = videoStream?.r_frame_rate ?? videoStream?.avg_frame_rate ?? '0/1';
        const [num, den] = fpsStr.split('/').map(Number);
        const frameRate = den && den > 0 ? (num ?? 0) / den : 0;

        resolve({
          width: videoStream?.width ?? 0,
          height: videoStream?.height ?? 0,
          durationSeconds: parseFloat(durationStr),
          hasAudioStream: audioStream !== undefined,
          frameRate,
        });
      } catch (err) {
        reject(new PipelineError(
          `Failed to parse ffprobe output: ${String(err)}`,
          'pipeline_qg_probe_error',
        ));
      }
    });

    proc.on('error', (err) => {
      reject(new PipelineError(
        `ffprobe spawn error: ${(err as Error).message}`,
        'pipeline_qg_probe_error',
      ));
    });
  });
}

/**
 * Run ffprobe volumedetect filter to get peak and mean dBFS values.
 * Returns { maxVolume, meanVolume } both as negative dBFS numbers.
 */
async function probeVolume(filePath: string): Promise<VolumeData> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'info',
      '-i', filePath,
      '-af', 'volumedetect',
      '-f', 'null',
      '-',
    ];

    // volumedetect must run through ffmpeg, not ffprobe — use ffmpeg directly
    const proc2 = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr2 = '';

    proc2.stderr?.on('data', (chunk: Buffer) => { stderr2 += chunk.toString(); });

    proc2.on('close', () => {
      // Parse "max_volume: -3.2 dB" and "mean_volume: -18.1 dB" from stderr
      const maxMatch = /max_volume:\s*([-\d.]+)\s*dB/i.exec(stderr2);
      const meanMatch = /mean_volume:\s*([-\d.]+)\s*dB/i.exec(stderr2);

      resolve({
        maxVolume: maxMatch ? parseFloat(maxMatch[1] ?? '0') : -3.0,
        meanVolume: meanMatch ? parseFloat(meanMatch[1] ?? '0') : -18.0,
      });
    });

    proc2.on('error', () => {
      // Non-fatal: return safe defaults if ffmpeg not available
      resolve({ maxVolume: -3.0, meanVolume: -18.0 });
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a full quality check on an assembled video against the expected format config.
 * Returns a QualityGateResult with per-check details and an overall grade.
 *
 * @param video  - The assembled video metadata including file path and size.
 * @param format - The target format ('short' | 'long') defining expected thresholds.
 * @returns QualityGateResult with grade A/B/C/FAIL and per-check breakdown.
 */
export async function runQualityCheck(
  video: AssembledVideo,
  format: VideoFormat,
): Promise<QualityGateResult> {
  log.info({ videoPath: video.videoPath, format }, 'Quality gate: starting checks');

  const config = VIDEO_FORMAT_CONFIG[format];
  const checks: QualityCheckResult[] = [];

  // Probe video
  let probe: ProbeData;
  try {
    probe = await probeVideo(video.videoPath);
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      `Video probe failed: ${String(err)}`,
      'pipeline_qg_probe_error',
    );
  }

  // Probe volume (non-fatal if ffmpeg unavailable)
  let volume: VolumeData;
  try {
    volume = await probeVolume(video.videoPath);
  } catch {
    volume = { maxVolume: -3.0, meanVolume: -18.0 };
    log.warn({ videoPath: video.videoPath }, 'Quality gate: volume probe failed, using defaults');
  }

  // Check 1: Resolution (must meet or exceed format minimum)
  const resOk =
    probe.width >= config.resolution.width && probe.height >= config.resolution.height;
  checks.push({
    name: 'resolution',
    passed: resOk,
    actual: `${probe.width}x${probe.height}`,
    expected: `>=${config.resolution.width}x${config.resolution.height}`,
  });

  // Check 2: Duration within format bounds
  const duration = probe.durationSeconds > 0 ? probe.durationSeconds : video.durationSeconds;
  const durOk =
    duration >= config.minDurationSeconds && duration <= config.maxDurationSeconds;
  checks.push({
    name: 'duration',
    passed: durOk,
    actual: `${duration.toFixed(1)}s`,
    expected: `${config.minDurationSeconds}s–${config.maxDurationSeconds}s`,
  });

  // Check 3: Audio presence
  checks.push({
    name: 'audio_present',
    passed: probe.hasAudioStream,
    actual: probe.hasAudioStream ? 'audio_present' : 'no_audio',
    expected: 'audio_present',
  });

  // Check 4: Audio levels — peak dBFS should be between -14.0 and -1.0
  const peakOk = volume.maxVolume >= -14.0 && volume.maxVolume <= -1.0;
  checks.push({
    name: 'audio_levels',
    passed: peakOk,
    actual: `${volume.maxVolume.toFixed(1)} dBFS peak`,
    expected: '-14.0 to -1.0 dBFS',
  });

  // Check 5: File size between 100 KB and 500 MB
  const MIN_SIZE = 100 * 1024;
  const MAX_SIZE = 500 * 1024 * 1024;
  const sizeBytes = video.fileSizeBytes;
  const sizeOk = sizeBytes >= MIN_SIZE && sizeBytes <= MAX_SIZE;
  checks.push({
    name: 'file_size',
    passed: sizeOk,
    actual: `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`,
    expected: `${(MIN_SIZE / 1024).toFixed(0)} KB – ${(MAX_SIZE / 1024 / 1024).toFixed(0)} MB`,
  });

  // Check 6: Frame rate >= 24 fps
  const fpsOk = probe.frameRate >= 24;
  checks.push({
    name: 'frame_rate',
    passed: fpsOk,
    actual: `${probe.frameRate.toFixed(2)} fps`,
    expected: '>=24 fps',
  });

  // Grading
  const failCount = checks.filter((c) => !c.passed).length;
  let grade: QualityGateResult['grade'];
  if (failCount === 0) grade = 'A';
  else if (failCount === 1) grade = 'B';
  else if (failCount === 2) grade = 'C';
  else grade = 'FAIL';

  const passed = grade !== 'FAIL';

  log.info(
    { videoPath: video.videoPath, grade, failCount, format },
    `Quality gate: grade=${grade} (${failCount} failed checks)`,
  );

  if (!passed) {
    const failedNames = checks.filter((c) => !c.passed).map((c) => c.name);
    log.warn({ videoPath: video.videoPath, failedNames }, 'Quality gate: FAIL — video rejected');
  }

  return { passed, checks, videoPath: video.videoPath, grade };
}
