/**
 * Remotion bridge — spawns the Remotion CLI as a child process and streams
 * render progress via stdout parsing. Used to render quiz/comparison videos.
 */

import { createLogger } from '../shared/logger.js';
import { PipelineError } from '../shared/errors.js';
import { spawn } from 'child_process';
import path from 'path';
import { mkdirSync } from 'fs';

const log = createLogger('pipeline:remotion-bridge');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderProgress {
  percent: number;
  framesRendered: number;
  totalFrames: number;
  fps: number;
  timeRemainingMs: number;
}

export type ProgressCallback = (progress: RenderProgress) => void;

export interface RenderOptions {
  compositionId: string;
  inputProps: Record<string, unknown>;
  outputPath: string;
  onProgress?: ProgressCallback;
  timeoutMs?: number;
}

export interface StillOptions {
  compositionId: string;
  inputProps: Record<string, unknown>;
  outputPath: string;
  frame?: number;
}

// ---------------------------------------------------------------------------
// Progress parsing
// ---------------------------------------------------------------------------

// Example Remotion output: "Rendered 42/120 frames (35%, 25.3 fps)"
const PROGRESS_REGEX = /Rendered (\d+)\/(\d+) frames \((\d+)%,?\s*([\d.]+)?\s*fps?\)/i;

function parseProgress(line: string): RenderProgress | null {
  const match = PROGRESS_REGEX.exec(line);
  if (!match) return null;

  const framesRendered = parseInt(match[1] ?? '0', 10);
  const totalFrames = parseInt(match[2] ?? '0', 10);
  const percent = parseInt(match[3] ?? '0', 10);
  const fps = parseFloat(match[4] ?? '0');
  const remaining = fps > 0 ? ((totalFrames - framesRendered) / fps) * 1000 : 0;

  return { percent, framesRendered, totalFrames, fps, timeRemainingMs: remaining };
}

// ---------------------------------------------------------------------------
// Core spawn logic
// ---------------------------------------------------------------------------

function ensureOutputDir(outputPath: string): void {
  try {
    mkdirSync(path.dirname(outputPath), { recursive: true });
  } catch (err) {
    throw new PipelineError(
      `Cannot create output dir for Remotion: ${String(err)}`,
      'pipeline_remotion_fs_error',
    );
  }
}

function spawnRemotion(
  args: string[],
  onProgress?: ProgressCallback,
  timeoutMs = 600_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    log.debug({ args: ['npx', 'remotion', ...args].join(' ') }, 'Spawning Remotion');

    const proc = spawn('npx', ['remotion', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(
        new PipelineError(
          `Remotion render timed out after ${timeoutMs}ms`,
          'pipeline_remotion_timeout',
        ),
      );
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        const progress = parseProgress(line);
        if (progress && onProgress) {
          onProgress(progress);
        }
        if (line.trim()) {
          log.debug({ line: line.trim() }, 'remotion stdout');
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new PipelineError(
            `Remotion exited with code ${String(code)}: ${stderr.slice(-500)}`,
            'pipeline_remotion_exit_error',
            { code, stderrTail: stderr.slice(-500) },
          ),
        );
      } else {
        resolve();
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new PipelineError(
          `Remotion spawn error: ${err.message}`,
          'pipeline_remotion_spawn_error',
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class RemotionBridge {
  /**
   * Render a Remotion composition to a video file.
   * Streams progress events to onProgress callback if provided.
   */
  async render(options: RenderOptions): Promise<void> {
    const { compositionId, inputProps, outputPath, onProgress, timeoutMs } = options;

    if (!compositionId || compositionId.trim().length === 0) {
      throw new PipelineError('compositionId must be non-empty', 'pipeline_remotion_invalid_args');
    }
    if (!outputPath || outputPath.trim().length === 0) {
      throw new PipelineError('outputPath must be non-empty', 'pipeline_remotion_invalid_args');
    }

    ensureOutputDir(outputPath);

    const propsJson = JSON.stringify(inputProps);
    const args = [
      'render',
      compositionId,
      outputPath,
      '--props', propsJson,
      '--log', 'verbose',
    ];

    log.info({ compositionId, outputPath }, 'Starting Remotion render');
    await spawnRemotion(args, onProgress, timeoutMs);
    log.info({ compositionId, outputPath }, 'Remotion render complete');
  }

  /**
   * Render a single still frame from a Remotion composition.
   */
  async renderStill(options: StillOptions): Promise<void> {
    const { compositionId, inputProps, outputPath, frame = 0 } = options;

    if (!compositionId || compositionId.trim().length === 0) {
      throw new PipelineError('compositionId must be non-empty', 'pipeline_remotion_invalid_args');
    }
    if (!outputPath || outputPath.trim().length === 0) {
      throw new PipelineError('outputPath must be non-empty', 'pipeline_remotion_invalid_args');
    }

    ensureOutputDir(outputPath);

    const propsJson = JSON.stringify(inputProps);
    const args = [
      'still',
      compositionId,
      outputPath,
      '--props', propsJson,
      '--frame', String(frame),
      '--log', 'verbose',
    ];

    log.info({ compositionId, outputPath, frame }, 'Starting Remotion still render');
    await spawnRemotion(args, undefined, 60_000);
    log.info({ compositionId, outputPath, frame }, 'Remotion still render complete');
  }
}
