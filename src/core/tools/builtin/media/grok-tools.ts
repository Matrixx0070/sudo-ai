/**
 * Grok media tools: media.grok-image, media.grok-video.
 *
 * Expose the FREE grok.com subscription media lanes (already shipped as the
 * `sudo-ai grok image|video` CLI) as in-chat agent tools. Both are:
 *   - flag-gated by SUDO_GROK_WEBSESSION (default OFF) — reuse isGrokWebSessionEnabled(),
 *   - owner-gated (deny explicitly-untrusted turns; they must never burn the seat quota
 *     or drive the durable browser),
 *   - lazy: grok-web-media (and its browser/oracle stack) is dynamically imported inside
 *     execute() so the tool registry never pulls Playwright/ws at load time.
 * grok.com path only — never api.x.ai; the underlying lib never falls back to the
 * metered API, so these tools cannot spend money.
 */

import { statSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult, ToolArtifact } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('media-grok');

/** Explicitly-untrusted turns may not generate media on the owner's paid seat. */
function ownerGate(ctx: ToolContext): ToolResult | null {
  if (ctx.isOwner === false) {
    return { success: false, output: 'media.grok-* is owner-only; this turn is not the owner.' };
  }
  return null;
}

const DISABLED_MSG =
  'Grok web session is disabled. Set SUDO_GROK_WEBSESSION=1 and provision it once with `sudo-ai grok websession setup`.';

/** Turn the lib's typed errors into concise, actionable tool output. */
function mapGrokError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (name === 'GrokWebDisabledError') {
    return DISABLED_MSG;
  }
  if (name === 'GrokWebReloginRequiredError') {
    return 'Grok SSO session expired. Re-provision it with `sudo-ai grok websession setup`.';
  }
  if (name === 'GrokWebQuotaExhaustedError') {
    return `Grok free quota exhausted (${msg}). It resets on the ~18h rolling window — try again later. (No metered fallback: nothing was billed.)`;
  }
  return `Grok media generation failed: ${msg}`;
}

function artifactFor(p: string): ToolArtifact {
  let size = 0;
  try { size = statSync(p).size; } catch { /* best effort */ }
  return { path: p, action: 'created', size };
}

// ---------------------------------------------------------------------------
// media.grok-image
// ---------------------------------------------------------------------------

export const grokImageTool: ToolDefinition = {
  name: 'media.grok-image',
  description: 'Generate image(s) FREE on the owner\'s Grok subscription (grok.com web lane, no metered API). Saves JPEG(s) to disk and returns the file path(s) + public URL. Owner-only; requires SUDO_GROK_WEBSESSION.',
  category: 'media',
  timeout: 120_000,
  parameters: {
    prompt: { type: 'string', required: true, description: 'Text description of the image to generate.' },
    aspectRatio: { type: 'string', description: 'Aspect ratio (default 1:1).', enum: ['1:1', '2:3', '3:2', '9:16', '16:9'], default: '1:1' },
    numGenerations: { type: 'number', description: 'How many images to generate (default 1).', default: 1 },
    pro: { type: 'boolean', description: 'Use the higher-quality "imagePro" tier if available (default false).', default: false },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const denied = ownerGate(ctx);
    if (denied) return denied;

    const prompt = (params['prompt'] as string | undefined)?.trim();
    if (!prompt) return { success: false, output: 'prompt is required.' };

    const media = await import('../../../../llm/grok-web-media.js');
    if (!media.isGrokWebSessionEnabled()) {
      return { success: false, output: DISABLED_MSG };
    }

    const opts: { aspectRatio?: string; numGenerations?: number; pro?: boolean } = {};
    if (typeof params['aspectRatio'] === 'string') opts.aspectRatio = params['aspectRatio'];
    if (typeof params['numGenerations'] === 'number') opts.numGenerations = params['numGenerations'];
    if (typeof params['pro'] === 'boolean') opts.pro = params['pro'];

    logger.info({ session: ctx.sessionId, ...opts }, 'media.grok-image invoked');
    try {
      const r = await media.generateGrokImage(prompt, opts);
      const artifacts = r.files.map(artifactFor);
      const out = `Grok image generated (${r.files.length} file(s))${r.url ? `; url: ${r.url}` : ''}. Saved: ${r.files.join(', ')}`;
      return { success: true, output: out, data: { url: r.url, files: r.files }, artifacts };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'media.grok-image failed');
      return { success: false, output: mapGrokError(err) };
    }
  },
};

// ---------------------------------------------------------------------------
// media.grok-video
// ---------------------------------------------------------------------------

export const grokVideoTool: ToolDefinition = {
  name: 'media.grok-video',
  description: 'Generate a short video FREE on the owner\'s Grok subscription (grok.com web lane, no metered API). Text-to-video, or image-to-video when imageUrl is given. Downloads the mp4 and returns its URL + local path. Owner-only; requires SUDO_GROK_WEBSESSION. Free quota is small (~8 / 18h).',
  category: 'media',
  timeout: 300_000,
  parameters: {
    prompt: { type: 'string', required: true, description: 'Text description of the video to generate.' },
    imageUrl: { type: 'string', description: 'Optional source image (public URL) for image-to-video.' },
    aspectRatio: { type: 'string', description: 'Aspect ratio (default 9:16).', enum: ['9:16', '16:9', '1:1'], default: '9:16' },
    videoLength: { type: 'number', description: 'Length in seconds (default 6).', default: 6 },
    resolutionName: { type: 'string', description: 'Resolution tier (default 720p).', enum: ['480p', '720p'], default: '720p' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const denied = ownerGate(ctx);
    if (denied) return denied;

    const prompt = (params['prompt'] as string | undefined)?.trim();
    if (!prompt) return { success: false, output: 'prompt is required.' };

    const media = await import('../../../../llm/grok-web-media.js');
    if (!media.isGrokWebSessionEnabled()) {
      return { success: false, output: DISABLED_MSG };
    }

    const opts: { imageUrl?: string; aspectRatio?: string; videoLength?: number; resolutionName?: string } = {};
    if (typeof params['imageUrl'] === 'string') opts.imageUrl = params['imageUrl'];
    if (typeof params['aspectRatio'] === 'string') opts.aspectRatio = params['aspectRatio'];
    if (typeof params['videoLength'] === 'number') opts.videoLength = params['videoLength'];
    if (typeof params['resolutionName'] === 'string') opts.resolutionName = params['resolutionName'];

    logger.info({ session: ctx.sessionId, hasImage: Boolean(opts.imageUrl) }, 'media.grok-video invoked');
    try {
      const r = await media.generateGrokVideo(prompt, opts);
      const artifacts = r.file ? [artifactFor(r.file)] : [];
      const out = `Grok video generated. url: ${r.videoUrl}${r.file ? `; saved: ${r.file}` : ' (download step failed; URL only)'}`;
      return {
        success: true,
        output: out,
        data: { videoUrl: r.videoUrl, thumbnailUrl: r.thumbnailUrl, imageUrl: r.imageUrl, file: r.file, videoId: r.videoId },
        artifacts,
      };
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'media.grok-video failed');
      return { success: false, output: mapGrokError(err) };
    }
  },
};
