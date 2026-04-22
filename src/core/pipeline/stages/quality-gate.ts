/**
 * Quality gate stage — validates the assembled video against production standards.
 * Checks: resolution, duration, audio sync, file size. Uses ffprobe.
 */

import { createLogger } from '../../shared/logger.js';
import { PipelineError } from '../../shared/errors.js';
import type { PipelineRun, AssemblyResult, QualityReport, QualityCheck } from '../types.js';
import { spawn } from 'child_process';

const log = createLogger('pipeline:quality-gate');

// ---------------------------------------------------------------------------
// Acceptance thresholds
// ---------------------------------------------------------------------------

const EXPECTED_WIDTH = 1080;
const EXPECTED_HEIGHT = 1920;
const MIN_DURATION_S = 25;
const MAX_DURATION_S = 60;
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
const MIN_FILE_SIZE_BYTES = 100 * 1024; // 100 KB sanity floor

// ---------------------------------------------------------------------------
// ffprobe helpers
// ---------------------------------------------------------------------------

interface ProbeData {
  width: number;
  height: number;
  durationSeconds: number;
  hasAudioStream: boolean;
}

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
          'pipeline_qg_ffprobe_error',
        ));
        return;
      }

      try {
        const data = JSON.parse(stdout) as {
          streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
          format?: { duration?: string };
        };

        const videoStream = data.streams?.find((s) => s.codec_type === 'video');
        const audioStream = data.streams?.find((s) => s.codec_type === 'audio');
        const durationStr = videoStream?.duration ?? data.format?.duration ?? '0';

        resolve({
          width: videoStream?.width ?? 0,
          height: videoStream?.height ?? 0,
          durationSeconds: parseFloat(durationStr),
          hasAudioStream: audioStream !== undefined,
        });
      } catch (err) {
        reject(new PipelineError(
          `Failed to parse ffprobe output: ${String(err)}`,
          'pipeline_qg_parse_error',
        ));
      }
    });

    proc.on('error', (err) => {
      reject(new PipelineError(
        `ffprobe spawn error: ${err.message}`,
        'pipeline_qg_ffprobe_spawn',
      ));
    });
  });
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

export async function runQualityGate(
  run: PipelineRun,
  checkpoint: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  log.info({ runId: run.id }, 'Quality gate stage start');

  const assemblyOutput = checkpoint['assembly'] as { assembly?: AssemblyResult } | undefined;
  const assembly = assemblyOutput?.assembly;

  if (!assembly?.videoPath) {
    throw new PipelineError(
      'No assembly output found in checkpoint',
      'pipeline_qg_no_assembly',
    );
  }

  const { videoPath, fileSizeBytes, durationSeconds: assemblyDuration } = assembly;
  const checks: QualityCheck[] = [];

  // Probe actual video properties.
  let probe: ProbeData;
  try {
    probe = await probeVideo(videoPath);
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(
      `Video probe failed: ${String(err)}`,
      'pipeline_qg_probe_failed',
    );
  }

  // Check 1: Resolution
  const resolutionPassed = probe.width === EXPECTED_WIDTH && probe.height === EXPECTED_HEIGHT;
  checks.push({
    name: 'resolution',
    passed: resolutionPassed,
    actual: `${probe.width}x${probe.height}`,
    expected: `${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`,
  });

  // Check 2: Duration
  const duration = probe.durationSeconds > 0 ? probe.durationSeconds : assemblyDuration;
  const durationPassed = duration >= MIN_DURATION_S && duration <= MAX_DURATION_S;
  checks.push({
    name: 'duration',
    passed: durationPassed,
    actual: `${duration.toFixed(1)}s`,
    expected: `${MIN_DURATION_S}s–${MAX_DURATION_S}s`,
  });

  // Check 3: Audio sync (has audio stream)
  checks.push({
    name: 'audio_sync',
    passed: probe.hasAudioStream,
    actual: probe.hasAudioStream ? 'audio_present' : 'no_audio',
    expected: 'audio_present',
  });

  // Check 4: File size
  const sizePassed = fileSizeBytes >= MIN_FILE_SIZE_BYTES && fileSizeBytes <= MAX_FILE_SIZE_BYTES;
  checks.push({
    name: 'file_size',
    passed: sizePassed,
    actual: `${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB`,
    expected: `${(MIN_FILE_SIZE_BYTES / 1024).toFixed(0)}KB–${(MAX_FILE_SIZE_BYTES / 1024 / 1024).toFixed(0)}MB`,
  });

  const allPassed = checks.every((c) => c.passed);
  const report: QualityReport = { passed: allPassed, checks };

  const failedChecks = checks.filter((c) => !c.passed).map((c) => c.name);
  if (!allPassed) {
    log.warn(
      { runId: run.id, failedChecks, videoPath },
      'Quality gate FAILED — video does not meet production standards',
    );
  } else {
    log.info({ runId: run.id, videoPath }, 'Quality gate PASSED');
  }

  return { qualityGate: report, costUsd: 0 };
}
