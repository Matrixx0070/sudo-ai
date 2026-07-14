/**
 * Media factory tools: media.shorts-factory.
 */

import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { ensureDir, missingKey } from './helpers.js';
import { imageGenerateTool } from './image-tools.js';
import { toolFetch } from '../../../security/guarded-fetch.js';
// URL/key source only (caller 'tool:media-factory') — requests stay on toolFetch (SSRF guard).
import { getProviderApiKey } from '../../../../llm/client.js';
import { OPENAI_TTS_URL } from '../../../../llm/endpoints.js';

const logger = createLogger('media-factory');
const execFileAsync = promisify(execFile);

async function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  try {
    await execFileAsync('ffmpeg', ['-y', ...args], { signal, maxBuffer: 32 * 1024 * 1024 });
  } catch (err: unknown) {
    const e = err as { stderr?: string; code?: number };
    throw new Error(`ffmpeg error (code ${e.code ?? 1}): ${(e.stderr ?? String(err)).slice(-1000)}`);
  }
}

// ---------------------------------------------------------------------------
// media.shorts-factory
// ---------------------------------------------------------------------------

export const shortsFactoryTool: ToolDefinition = {
  name: 'media.shorts-factory',
  description:
    'Auto-produce a vertical short-form video (9:16, 1080x1920) from a narration script. Orchestrates: DALL-E background image → OpenAI TTS voiceover → ffmpeg assembly. Requires OPENAI_API_KEY.',
  category: 'media',
  timeout: 600_000,
  parameters: {
    script: { type: 'string', required: true, description: 'Narration script for the short video.' },
    outputPath: { type: 'string', required: true, description: 'Absolute path for the final MP4 short.' },
    backgroundImagePath: { type: 'string', description: 'Optional pre-made background image path. If omitted, DALL-E generates one.' },
    imagePrompt: { type: 'string', description: 'Custom DALL-E prompt for background image (overrides auto-prompt).' },
    voiceId: { type: 'string', description: 'OpenAI TTS voice (default: alloy).', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'], default: 'alloy' },
    titleText: { type: 'string', description: 'Optional title text to burn into the video.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const script = params['script'] as string | undefined;
    const outputPath = params['outputPath'] as string | undefined;
    const voiceId = (params['voiceId'] as string | undefined) ?? 'alloy';
    const titleText = params['titleText'] as string | undefined;

    if (!script?.trim()) return { success: false, output: 'script is required.' };
    if (!outputPath?.trim()) return { success: false, output: 'outputPath is required.' };

    const apiKey = getProviderApiKey('openai');
    if (!apiKey) return missingKey('OPENAI_API_KEY', 'media.shorts-factory');

    logger.info({ session: ctx.sessionId, scriptLen: script.length, voiceId }, 'media.shorts-factory invoked');

    try {
      ensureDir(path.dirname(outputPath));
      const tmpDir = path.dirname(outputPath);

      // Step 1: Generate or use existing background image
      let bgImagePath = params['backgroundImagePath'] as string | undefined;
      if (!bgImagePath) {
        const imgPrompt = (params['imagePrompt'] as string | undefined)
          ?? `Cinematic vertical 9:16 background for a short video about: ${script.slice(0, 200)}. No text. Dramatic lighting.`;
        bgImagePath = path.join(tmpDir, `shorts_bg_${Date.now()}.png`);
        const imgResult = await imageGenerateTool.execute({
          prompt: imgPrompt,
          outputPath: bgImagePath,
          provider: 'dalle',
          size: '1024x1792',
        }, ctx);
        if (!imgResult.success) {
          return { success: false, output: `Shorts factory image step failed: ${imgResult.output}` };
        }
        logger.info({ bgImagePath }, 'Background image generated');
      }

      // Step 2: Generate voiceover via OpenAI TTS
      const audioPath = path.join(tmpDir, `shorts_audio_${Date.now()}.mp3`);
      const ttsRes = await toolFetch(OPENAI_TTS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: ctx.signal,
        body: JSON.stringify({ model: 'tts-1', voice: voiceId, input: script, response_format: 'mp3' }),
      });
      if (!ttsRes.ok) {
        throw new Error(`OpenAI TTS error ${ttsRes.status}: ${(await ttsRes.text()).slice(0, 200)}`);
      }
      const audioBuf = Buffer.from(await ttsRes.arrayBuffer());
      writeFileSync(audioPath, audioBuf);
      logger.info({ audioPath, audioBytes: audioBuf.length }, 'Voiceover generated');

      // Step 3: Assemble with ffmpeg — loop image over audio duration
      const drawTextFilter = titleText
        ? `,drawtext=text='${titleText.replace(/'/g, "\\'").replace(/:/g, '\\:')}':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=80:box=1:boxcolor=black@0.5:boxborderw=10`
        : '';

      await runFfmpeg([
        '-loop', '1',
        '-i', bgImagePath,
        '-i', audioPath,
        '-c:v', 'libx264',
        '-tune', 'stillimage',
        '-vf', `scale=1080:1920,setsar=1${drawTextFilter}`,
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        outputPath,
      ], ctx.signal);

      logger.info({ outputPath }, 'Shorts factory assembly complete');
      const artifacts: ToolArtifact[] = [
        { path: outputPath, action: 'created' },
        { path: audioPath, action: 'created' },
        { path: bgImagePath, action: 'created' },
      ];
      return {
        success: true,
        output: `Short video assembled. Saved to: ${outputPath}`,
        data: { outputPath, audioPath, bgImagePath, voiceId },
        artifacts,
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'media.shorts-factory failed');
      return { success: false, output: `Shorts factory failed: ${msg}` };
    }
  },
};
