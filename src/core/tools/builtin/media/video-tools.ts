/**
 * Media video tools: media.video-edit, media.video-generate, media.video-to-clips.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { ensureDir, missingKey } from './helpers.js';

const logger = createLogger('media-video');
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function runFfmpeg(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('ffmpeg', ['-y', ...args], { signal, maxBuffer: 16 * 1024 * 1024 });
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(err) };
  }
}

async function pollForUrl(
  pollFn: () => Promise<{ done: boolean; url?: string; failed?: boolean }>,
  maxAttempts: number,
  intervalMs: number,
  signal?: AbortSignal,
): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await pollFn();
    if (result.failed) throw new Error('Video generation failed on provider side.');
    if (result.done && result.url) return result.url;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    if (signal?.aborted) throw new Error('Aborted while polling for video.');
  }
  throw new Error('Timed out waiting for video generation.');
}

// ---------------------------------------------------------------------------
// media.video-edit
// ---------------------------------------------------------------------------

export const videoEditTool: ToolDefinition = {
  name: 'media.video-edit',
  description: 'Edit videos via ffmpeg: convert, trim, merge, extract-audio, add-subtitles, compress, gif, or text-overlay. Full wrapper around the super.ffmpeg engine.',
  category: 'media',
  timeout: 600_000,
  parameters: {
    operation: { type: 'string', required: true, description: 'ffmpeg operation.', enum: ['convert', 'trim', 'merge', 'extract-audio', 'add-subtitles', 'compress', 'gif', 'text-overlay'] },
    input: { type: 'string', required: true, description: 'Absolute path to primary input video.' },
    output: { type: 'string', required: true, description: 'Absolute path for output file.' },
    startTime: { type: 'string', description: 'Start time HH:MM:SS or seconds (trim/gif).' },
    duration: { type: 'string', description: 'Duration HH:MM:SS or seconds (trim/gif).' },
    endTime: { type: 'string', description: 'End time HH:MM:SS (trim).' },
    inputs: { type: 'array', description: 'Additional input files for merge.', items: { type: 'string', description: 'Input file path.' } },
    subtitlesFile: { type: 'string', description: '.srt subtitle file path (add-subtitles).' },
    overlayText: { type: 'string', description: 'Text to burn into video (text-overlay).' },
    crf: { type: 'number', description: 'CRF quality 0-51 for compress (default: 28).' },
    fps: { type: 'number', description: 'Frames per second for GIF.' },
    audioCodec: { type: 'string', description: 'Audio codec for extract-audio (default: libmp3lame).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const operation = params['operation'] as string | undefined;
    const input = params['input'] as string | undefined;
    const output = params['output'] as string | undefined;

    if (!operation) return { success: false, output: 'operation is required.' };
    if (!input) return { success: false, output: 'input is required.' };
    if (!output) return { success: false, output: 'output is required.' };

    logger.info({ session: ctx.sessionId, operation, input }, 'media.video-edit invoked');

    try {
      if (operation === 'text-overlay') {
        const overlayText = params['overlayText'] as string | undefined;
        if (!overlayText?.trim()) return { success: false, output: 'overlayText is required for text-overlay.' };
        const safe = overlayText.replace(/'/g, "\\'").replace(/:/g, '\\:');
        await runFfmpeg(['-i', input, '-vf', `drawtext=text='${safe}':fontsize=48:fontcolor=white:x=10:y=10`, '-codec:a', 'copy', output], ctx.signal);
        const artifacts: ToolArtifact[] = [{ path: output, action: 'created' }];
        return { success: true, output: `Text overlay applied. Output: ${output}`, data: { operation, input, output }, artifacts };
      }

      const { ffmpegTool } = await import('../../../superpowers/ffmpeg-tools.js');
      const options: Record<string, unknown> = {};
      if (params['startTime']) options['startTime'] = params['startTime'];
      if (params['duration']) options['duration'] = params['duration'];
      if (params['endTime']) options['endTime'] = params['endTime'];
      if (params['inputs']) options['inputs'] = params['inputs'];
      if (params['subtitlesFile']) options['subtitlesFile'] = params['subtitlesFile'];
      if (params['crf'] !== undefined) options['crf'] = params['crf'];
      if (params['fps'] !== undefined) options['fps'] = params['fps'];
      if (params['audioCodec']) options['audioCodec'] = params['audioCodec'];
      return ffmpegTool.execute({ operation, input, output, options }, ctx);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ operation, err: msg }, 'media.video-edit failed');
      return { success: false, output: `Video edit failed: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// media.video-generate
// ---------------------------------------------------------------------------

export const videoGenerateTool: ToolDefinition = {
  name: 'media.video-generate',
  description: 'Generate short videos from text prompts or images via AI APIs: Luma Dream Machine, RunwayML, Kling. Polls until done, downloads and saves the MP4.',
  category: 'media',
  timeout: 300_000,
  parameters: {
    prompt: { type: 'string', required: true, description: 'Text prompt describing the video.' },
    outputPath: { type: 'string', required: true, description: 'Absolute path to save the generated MP4.' },
    provider: { type: 'string', description: 'AI provider (default: luma).', enum: ['luma', 'runway', 'kling'], default: 'luma' },
    imageUrl: { type: 'string', description: 'Source image URL for image-to-video.' },
    durationSeconds: { type: 'number', description: 'Desired duration in seconds (default: 5).', default: 5 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const prompt = params['prompt'] as string | undefined;
    const outputPath = params['outputPath'] as string | undefined;
    const provider = (params['provider'] as string | undefined) ?? 'luma';
    const imageUrl = params['imageUrl'] as string | undefined;
    const durationSeconds = (params['durationSeconds'] as number | undefined) ?? 5;

    if (!prompt?.trim()) return { success: false, output: 'prompt is required.' };
    if (!outputPath?.trim()) return { success: false, output: 'outputPath is required.' };

    logger.info({ session: ctx.sessionId, provider }, 'media.video-generate invoked');

    try {
      let videoUrl: string;

      if (provider === 'luma') {
        const apiKey = process.env['LUMA_API_KEY'];
        if (!apiKey) return missingKey('LUMA_API_KEY', 'media.video-generate');
        const body: Record<string, unknown> = { prompt, aspect_ratio: '9:16' };
        if (imageUrl) body['keyframes'] = { frame0: { type: 'image', url: imageUrl } };
        const genRes = await fetch('https://api.lumalabs.ai/dream-machine/v1/generations', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          signal: ctx.signal, body: JSON.stringify(body),
        });
        if (!genRes.ok) throw new Error(`Luma API error ${genRes.status}: ${(await genRes.text()).slice(0, 200)}`);
        const gen = await genRes.json() as { id: string; state?: string; assets?: { video?: string } };
        videoUrl = await pollForUrl(async () => {
          const r = await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${gen.id}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctx.signal });
          const d = await r.json() as typeof gen;
          return { done: d.state === 'completed', url: d.assets?.video, failed: d.state === 'failed' };
        }, 48, 5000, ctx.signal);

      } else if (provider === 'runway') {
        const apiKey = process.env['RUNWAY_API_KEY'];
        if (!apiKey) return missingKey('RUNWAY_API_KEY', 'media.video-generate');
        const body: Record<string, unknown> = { promptText: prompt, duration: durationSeconds, ratio: '768:1280', model: 'gen3a_turbo' };
        if (imageUrl) body['promptImage'] = imageUrl;
        const genRes = await fetch('https://api.dev.runwayml.com/v1/image_to_video', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Runway-Version': '2024-11-06' },
          signal: ctx.signal, body: JSON.stringify(body),
        });
        if (!genRes.ok) throw new Error(`Runway error ${genRes.status}: ${(await genRes.text()).slice(0, 200)}`);
        const task = await genRes.json() as { id: string; status?: string; output?: string[] };
        videoUrl = await pollForUrl(async () => {
          const r = await fetch(`https://api.dev.runwayml.com/v1/tasks/${task.id}`, { headers: { Authorization: `Bearer ${apiKey}`, 'X-Runway-Version': '2024-11-06' }, signal: ctx.signal });
          const d = await r.json() as typeof task;
          return { done: d.status === 'SUCCEEDED', url: d.output?.[0], failed: d.status === 'FAILED' };
        }, 48, 5000, ctx.signal);

      } else if (provider === 'kling') {
        const apiKey = process.env['KLING_API_KEY'];
        if (!apiKey) return missingKey('KLING_API_KEY', 'media.video-generate');
        const genRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          signal: ctx.signal, body: JSON.stringify({ prompt, cfg_scale: 0.5, mode: 'std', duration: String(durationSeconds) }),
        });
        if (!genRes.ok) throw new Error(`Kling error ${genRes.status}: ${(await genRes.text()).slice(0, 200)}`);
        const task = await genRes.json() as { data?: { task_id: string } };
        const taskId = task.data?.task_id;
        if (!taskId) throw new Error('Kling: no task_id in response.');
        videoUrl = await pollForUrl(async () => {
          const r = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctx.signal });
          const d = await r.json() as { data?: { task_status: string; task_result?: { videos?: Array<{ url: string }> } } };
          return { done: d.data?.task_status === 'succeed', url: d.data?.task_result?.videos?.[0]?.url, failed: d.data?.task_status === 'failed' };
        }, 48, 5000, ctx.signal);

      } else {
        return { success: false, output: `Unknown provider: ${provider}` };
      }

      ensureDir(path.dirname(outputPath));
      const vidRes = await fetch(videoUrl, { signal: ctx.signal });
      if (!vidRes.ok) throw new Error(`Failed to download video: ${vidRes.status}`);
      const vidBuf = Buffer.from(await vidRes.arrayBuffer());
      writeFileSync(outputPath, vidBuf);
      logger.info({ outputPath, provider }, 'Video generated and saved');
      const artifacts: ToolArtifact[] = [{ path: outputPath, action: 'created', size: vidBuf.length }];
      return { success: true, output: `Video generated with ${provider}. Saved to: ${outputPath}`, data: { provider, outputPath }, artifacts };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ provider, err: msg }, 'media.video-generate failed');
      return { success: false, output: `Video generation failed: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// media.video-to-clips
// ---------------------------------------------------------------------------

export const videoToClipsTool: ToolDefinition = {
  name: 'media.video-to-clips',
  description: 'Auto-detect scene changes in a long video and split into individual clip files using ffmpeg scene detection. Returns list of output clip paths.',
  category: 'media',
  timeout: 600_000,
  parameters: {
    input: { type: 'string', required: true, description: 'Absolute path to source video.' },
    outputDir: { type: 'string', required: true, description: 'Directory where clips will be saved.' },
    threshold: { type: 'number', description: 'Scene change sensitivity 0.0-1.0 (default: 0.3).', default: 0.3 },
    minClipDuration: { type: 'number', description: 'Minimum clip duration in seconds (default: 5).', default: 5 },
    maxClips: { type: 'number', description: 'Maximum clips to produce (default: 20).', default: 20 },
    outputFormat: { type: 'string', description: 'Output container (default: mp4).', enum: ['mp4', 'mov', 'webm'], default: 'mp4' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const input = params['input'] as string | undefined;
    const outputDir = params['outputDir'] as string | undefined;
    const threshold = (params['threshold'] as number | undefined) ?? 0.3;
    const minClipDuration = (params['minClipDuration'] as number | undefined) ?? 5;
    const maxClips = (params['maxClips'] as number | undefined) ?? 20;
    const outputFormat = (params['outputFormat'] as string | undefined) ?? 'mp4';

    if (!input?.trim()) return { success: false, output: 'input is required.' };
    if (!outputDir?.trim()) return { success: false, output: 'outputDir is required.' };

    logger.info({ session: ctx.sessionId, input, threshold }, 'media.video-to-clips invoked');

    try {
      mkdirSync(outputDir, { recursive: true });

      const { stdout: probeOut } = await execFileAsync('ffprobe', [
        '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input,
      ], { maxBuffer: 1024 * 1024 });
      const totalDuration = parseFloat(probeOut.trim()) || 0;
      if (totalDuration === 0) throw new Error('Could not determine video duration.');

      const { stderr: sceneOut } = await runFfmpeg([
        '-i', input, '-vf', `select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-',
      ], ctx.signal);

      const timeRegex = /pts_time:([\d.]+)/g;
      const sceneTimes: number[] = [0];
      let match: RegExpExecArray | null;
      while ((match = timeRegex.exec(sceneOut)) !== null) {
        const t = parseFloat(match[1]);
        const last = sceneTimes[sceneTimes.length - 1] ?? 0;
        if (t - last >= minClipDuration) sceneTimes.push(t);
      }
      sceneTimes.push(totalDuration);

      const clipPaths: string[] = [];
      const cutCount = Math.min(sceneTimes.length - 1, maxClips);

      for (let i = 0; i < cutCount; i++) {
        const start = sceneTimes[i] ?? 0;
        const end = sceneTimes[i + 1] ?? totalDuration;
        const dur = end - start;
        if (dur < minClipDuration) continue;
        const clipPath = path.join(outputDir, `clip_${String(i + 1).padStart(3, '0')}.${outputFormat}`);
        await runFfmpeg(['-ss', String(start), '-i', input, '-t', String(dur), '-c', 'copy', clipPath], ctx.signal);
        clipPaths.push(clipPath);
      }

      logger.info({ clipCount: clipPaths.length, outputDir }, 'Video split into clips');
      const artifacts: ToolArtifact[] = clipPaths.map((p) => ({ path: p, action: 'created' as const }));
      return { success: true, output: `Split into ${clipPaths.length} clips in: ${outputDir}`, data: { clipPaths, totalDuration, clipCount: clipPaths.length }, artifacts };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ input, err: msg }, 'media.video-to-clips failed');
      return { success: false, output: `Video-to-clips failed: ${msg}` };
    }
  },
};
