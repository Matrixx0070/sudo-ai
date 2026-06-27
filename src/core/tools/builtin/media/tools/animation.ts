/**
 * @file animation.ts
 * @description media.animation — assemble a looping animated GIF from an ordered
 * sequence of frames (story-style caption cards). Each frame is rendered to a PNG
 * by playwright-core chromium (its own headless instance, no CDP collision), then
 * ffmpeg stitches the frames into a high-quality palettised, infinitely-looping GIF
 * (runFfmpegSilent, single-pass palettegen/paletteuse). The "Animation saved to:
 * <path>.gif" output is picked up by the loop's file-attachment extractor → inline
 * image that animates in the web client.
 */

import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import { runFfmpegSilent } from '../helpers.js';

const logger = createLogger('media:animation');

const FRAME_W = 800;
const FRAME_H = 450;
const MAX_FRAMES = 30;
const DEFAULT_FRAME_MS = 1400;
const MIN_FRAME_MS = 300;
const MAX_FRAME_MS = 5_000;
const ACCENT = '#6d28d9';

export interface AnimFrame {
  text: string;
  subtitle?: string;
}

function esc(s: string): string {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/**
 * Coerce the model's `frames` argument into clean AnimFrame[]. As with other
 * nested-array tools, the LLM may pass the whole array as a JSON STRING, the items
 * as plain strings, or use `title` instead of `text` — normalise all of them and
 * drop empties. Returns [] when nothing usable is found.
 */
export function normalizeFramesArg(raw: unknown): AnimFrame[] {
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out: AnimFrame[] = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ text: item.trim() });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const text = typeof o['text'] === 'string' ? o['text'] : typeof o['title'] === 'string' ? o['title'] : '';
    if (!text.trim()) continue;
    const subtitle = typeof o['subtitle'] === 'string' ? o['subtitle'] : undefined;
    out.push({ text: text.trim(), ...(subtitle && subtitle.trim() ? { subtitle: subtitle.trim() } : {}) });
  }
  return out;
}

/**
 * Build one frame's HTML — a full-bleed gradient caption card with big centred
 * text, an optional subtitle, and a progress-dot row marking position in the
 * sequence. Pure + exported so the frame structure is unit-tested without a
 * browser or ffmpeg.
 */
export function buildFrameHtml(frame: AnimFrame, index: number, total: number): string {
  const dots = Array.from({ length: total }, (_, i) =>
    `<span class="dot${i === index ? ' on' : ''}"></span>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${FRAME_W}px; height:${FRAME_H}px; overflow:hidden; }
  body { background:linear-gradient(135deg, ${ACCENT} 0%, #1e3a8a 100%); color:#fff;
         font-family:'Segoe UI',Arial,Helvetica,sans-serif; display:flex; flex-direction:column;
         align-items:center; justify-content:center; text-align:center; padding:64px 72px; position:relative; }
  .text { font-size:54px; font-weight:800; line-height:1.18; max-width:100%; word-wrap:break-word; }
  .sub { font-size:26px; font-weight:400; opacity:0.88; margin-top:24px; }
  .dots { position:absolute; bottom:30px; left:0; right:0; display:flex; gap:10px; justify-content:center; }
  .dot { width:9px; height:9px; border-radius:50%; background:rgba(255,255,255,0.32); }
  .dot.on { background:#fff; width:11px; height:11px; }
  </style></head><body>
  <div class="text">${esc(frame.text)}</div>
  ${frame.subtitle ? `<div class="sub">${esc(frame.subtitle)}</div>` : ''}
  <div class="dots">${dots}</div>
  </body></html>`;
}

export const animationTool: ToolDefinition = {
  name: 'media.animation',
  description:
    'Create a looping animated GIF from an ordered sequence of frames (caption cards) and deliver it to the ' +
    'chat. Use for "make an animated gif", "animate these steps/tips", "a looping reel". Supply `frames` as an ' +
    'array of { text, subtitle? } shown one after another; optional frameDurationMs sets how long each frame holds.',
  category: 'media',
  timeout: 60_000,
  parameters: {
    frames: {
      type: 'array',
      required: true,
      description: 'Ordered frames, each { text, subtitle? }, shown in sequence.',
      items: {
        type: 'object',
        description: 'A frame: { text, subtitle? }.',
        properties: {
          text: { type: 'string', description: 'The big caption for this frame.' },
          subtitle: { type: 'string', description: 'Optional smaller line under the caption.' },
        },
      },
    },
    frameDurationMs: { type: 'number', description: `How long each frame holds, ms (default ${DEFAULT_FRAME_MS}).` },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const frames = normalizeFramesArg(params['frames']);
    if (frames.length === 0) {
      return { success: false, output: 'frames must be a non-empty array of { text, subtitle? } (a JSON string of that array is also accepted).' };
    }
    if (frames.length > MAX_FRAMES) {
      return { success: false, output: `Too many frames (max ${MAX_FRAMES}, got ${frames.length}).` };
    }
    const frameMs = Math.max(MIN_FRAME_MS, Math.min(MAX_FRAME_MS,
      typeof params['frameDurationMs'] === 'number' ? (params['frameDurationMs'] as number) : DEFAULT_FRAME_MS));
    const fps = 1000 / frameMs;
    const outPath = `/tmp/animation-${Date.now()}.gif`;
    const dir = mkdtempSync(join(tmpdir(), 'anim-'));

    logger.info({ session: ctx.sessionId, frames: frames.length, frameMs }, 'media.animation invoked');

    let browser: import('playwright-core').Browser | undefined;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.setViewportSize({ width: FRAME_W, height: FRAME_H });
      for (let i = 0; i < frames.length; i++) {
        await page.setContent(buildFrameHtml(frames[i]!, i, frames.length), { waitUntil: 'load', timeout: 15_000 });
        await page.screenshot({ path: join(dir, `f-${String(i + 1).padStart(3, '0')}.png`), type: 'png' });
      }
      await browser.close().catch(() => { /* best-effort */ });
      browser = undefined;

      // Single-pass palettegen/paletteuse → good-quality, infinitely-looping GIF.
      await runFfmpegSilent([
        '-framerate', fps.toFixed(4),
        '-i', join(dir, 'f-%03d.png'),
        '-vf', 'split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a',
        '-loop', '0',
        outPath,
      ], ctx.signal);

      const size = statSync(outPath).size;
      logger.info({ outPath, size, frames: frames.length }, 'Animated GIF rendered');
      return {
        success: true,
        output: `Animation saved to: ${outPath} — delivered to the chat as a looping GIF (${frames.length} frames, ${size} bytes).`,
        data: { path: outPath, frames: frames.length, bytes: size },
        artifacts: [{ path: outPath, action: 'created', size }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'media.animation render failed');
      return { success: false, output: `Animation render failed: ${msg}` };
    } finally {
      if (browser) await browser.close().catch(() => { /* best-effort */ });
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  },
};

export default animationTool;
