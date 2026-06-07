/**
 * super.ffmpeg — Video/audio manipulation via ffmpeg.
 *
 * All operations use execFile with argument arrays (no shell interpolation).
 * Supported: convert, trim, merge, extract-audio, add-subtitles, compress, gif.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../tools/types.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('super.ffmpeg');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FfmpegOptions {
  startTime?: string;
  duration?: string;
  endTime?: string;
  audioCodec?: string;
  videoCodec?: string;
  crf?: number;
  fps?: number;
  scale?: string;
  subtitlesFile?: string;
  inputs?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runFfmpeg(args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('ffmpeg', ['-y', ...args], {
      signal,
      maxBuffer: 16 * 1024 * 1024,
    });
    return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').slice(-2000);
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; code?: number };
    const details = (e.stderr ?? e.stdout ?? String(err)).slice(-2000);
    throw new Error(`ffmpeg exited with code ${e.code ?? 1}: ${details}`);
  }
}

function buildArgs(
  operation: string,
  input: string,
  output: string,
  opts: FfmpegOptions,
): string[] {
  switch (operation) {
    case 'convert':
      return ['-i', input, output];

    case 'trim': {
      const args = ['-i', input];
      if (opts.startTime) args.push('-ss', opts.startTime);
      if (opts.duration) args.push('-t', opts.duration);
      if (opts.endTime) args.push('-to', opts.endTime);
      args.push('-c', 'copy', output);
      return args;
    }

    case 'merge': {
      if (!opts.inputs?.length) throw new Error('merge requires options.inputs array');
      const args: string[] = [];
      for (const inp of opts.inputs) args.push('-i', inp);
      args.push(
        '-filter_complex', `concat=n=${opts.inputs.length}:v=1:a=1[v][a]`,
        '-map', '[v]', '-map', '[a]', output,
      );
      return args;
    }

    case 'extract-audio':
      return ['-i', input, '-vn', '-acodec', opts.audioCodec ?? 'libmp3lame', output];

    case 'add-subtitles': {
      if (!opts.subtitlesFile) throw new Error('add-subtitles requires options.subtitlesFile');
      return ['-i', input, '-vf', `subtitles=${opts.subtitlesFile}`, output];
    }

    case 'compress': {
      const crf = opts.crf ?? 28;
      return ['-i', input, '-vcodec', 'libx264', '-crf', String(crf), '-preset', 'fast', output];
    }

    case 'gif': {
      const fps = opts.fps ?? 15;
      const scale = opts.scale ?? '480:-1';
      const args = ['-i', input];
      if (opts.startTime) args.push('-ss', opts.startTime);
      if (opts.duration) args.push('-t', opts.duration);
      args.push(
        '-vf', `fps=${fps},scale=${scale}:flags=lanczos,palettegen=stats_mode=diff`,
        '-y', '/tmp/_sudo_palette.png',
      );
      // Two-pass GIF: first generate palette, then apply
      return args;
    }

    default:
      throw new Error(`Unknown ffmpeg operation: ${operation}`);
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const ffmpegTool: ToolDefinition = {
  name: 'super.ffmpeg',
  description: 'Video/audio manipulation via ffmpeg: convert, trim, merge, extract-audio, add-subtitles, compress, or create GIF.',
  category: 'superpowers',
  requiresConfirmation: false,
  timeout: 300_000,
  parameters: {
    operation: {
      type: 'string',
      description: 'ffmpeg operation to perform.',
      required: true,
      enum: ['convert', 'trim', 'merge', 'extract-audio', 'add-subtitles', 'compress', 'gif'],
    },
    input: { type: 'string', description: 'Absolute path to input media file.', required: true },
    output: { type: 'string', description: 'Absolute path for output file.', required: true },
    options: {
      type: 'object',
      description: 'Operation-specific options.',
      properties: {
        startTime:     { type: 'string', description: 'Start time (HH:MM:SS or seconds) for trim/gif.' },
        duration:      { type: 'string', description: 'Duration (HH:MM:SS or seconds) for trim/gif.' },
        endTime:       { type: 'string', description: 'End time for trim.' },
        audioCodec:    { type: 'string', description: 'Audio codec for extract-audio (default: libmp3lame).' },
        crf:           { type: 'number', description: 'CRF quality (0-51, lower=better) for compress.' },
        fps:           { type: 'number', description: 'Frames per second for GIF.' },
        scale:         { type: 'string', description: 'Scale filter for GIF (e.g. 480:-1).' },
        subtitlesFile: { type: 'string', description: 'Path to .srt subtitle file.' },
        inputs:        { type: 'array', description: 'Input files for merge.', items: { type: 'string', description: 'Input file path.' } },
      },
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const operation = params['operation'] as string | undefined;
    const input = params['input'] as string | undefined;
    const output = params['output'] as string | undefined;
    const options = (params['options'] as FfmpegOptions | undefined) ?? {};

    if (!operation) return { success: false, output: 'operation is required.' };
    if (!input) return { success: false, output: 'input is required.' };
    if (!output) return { success: false, output: 'output is required.' };

    logger.info({ session: ctx.sessionId, operation, input, output }, 'ffmpeg operation started');

    try {
      let args: string[];
      try {
        args = buildArgs(operation, input, output, options);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: `Invalid operation config: ${msg}` };
      }

      // GIF needs two-pass
      if (operation === 'gif') {
        const palette = '/tmp/_sudo_palette.png';
        await runFfmpeg(args, ctx.signal);
        const fps = options.fps ?? 15;
        const scale = options.scale ?? '480:-1';
        const pre: string[] = [];
        if (options.startTime) pre.push('-ss', options.startTime);
        if (options.duration) pre.push('-t', options.duration);
        const pass2 = [...pre, '-i', input, '-i', palette, '-lavfi', `fps=${fps},scale=${scale}:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer`, output];
        await runFfmpeg(pass2, ctx.signal);
      } else {
        await runFfmpeg(args, ctx.signal);
      }

      logger.info({ operation, output }, 'ffmpeg operation complete');
      const artifacts: ToolArtifact[] = [{ path: output, action: 'created' }];

      return {
        success: true,
        output: `ffmpeg ${operation} complete. Output: ${output}`,
        data: { operation, input, output },
        artifacts,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ operation, err: msg }, 'ffmpeg failed');
      return { success: false, output: `ffmpeg failed: ${msg}` };
    }
  },
};
