/**
 * @file vision.ts
 * @description browser.vision — analyze screenshots/images using vision AI.
 *
 * Provider priority:
 *   1. The agent's own Brain (ctx.config.brain) — the main LLM (Claude via
 *      claude-oauth in prod) is vision-capable, so this needs NO extra keys.
 *   2. xAI   (XAI_API_KEY)    — standalone HTTP fallback
 *   3. OpenAI (OPENAI_API_KEY) — standalone HTTP fallback
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { visionIR } from '../../../../llm/client.js';
import type { BrainMessage } from '../../../brain/types.js';

const log = createLogger('browser:vision');

/** Minimal shape of the Brain we need — image-capable call(). */
interface BrainLike {
  call(req: {
    messages: BrainMessage[];
    model?: string;
    inputModalities?: Array<'text' | 'image' | 'audio'>;
  }): Promise<{ content?: string }>;
}
interface ConfigLike { brain?: BrainLike }

type VisionMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

// HTTP fallback model (xAI attempt inside visionIR; its OpenAI fallback uses gpt-4o).
const FALLBACK_VISION_MODEL = 'xai/grok-4-fast-non-reasoning';

const MAX_OUTPUT_CHARS = 4_000;

const MIME_BY_EXT: Record<string, string> = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
};

function getMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

async function readImageAsBase64(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return buf.toString('base64');
}

export const visionTool: ToolDefinition = {
  name: 'browser.vision',
  description:
    'SEE any image: analyze a screenshot, photo, or image file with AI vision. Uses the main ' +
    'brain model (Claude vision) directly — ALWAYS available, no extra API keys needed ' +
    '(xAI/OpenAI HTTP are only fallbacks). Use this whenever a user shares an image ' +
    '("[Image attached: ...]"). Pass the image path and a specific question; returns a text answer.',
  category: 'browser',
  timeout: 90_000,
  parameters: {
    imagePath: {
      type: 'string',
      required: true,
      description: 'Absolute or relative path to PNG/JPG/GIF/WEBP image file (max 15 MB).',
    },
    question: {
      type: 'string',
      required: true,
      description: 'Specific question about the image (e.g. "What text is visible?" or "Describe the UI elements").',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const imagePath = typeof params['imagePath'] === 'string' ? params['imagePath'] : '';
    const question  = typeof params['question']  === 'string' ? params['question']  : '';

    if (!imagePath) return { success: false, output: 'browser.vision: "imagePath" is required.' };
    if (!question)  return { success: false, output: 'browser.vision: "question" is required.' };

    // File I/O + size check
    let base64: string;
    try {
      const stat = await fs.stat(imagePath);
      if (stat.size > 15 * 1024 * 1024) {
        return {
          success: false,
          output: `browser.vision: image too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Max 15 MB.`,
        };
      }
      base64 = await readImageAsBase64(imagePath);
    } catch (err) {
      return { success: false, output: `browser.vision: cannot read image — ${(err as Error).message}` };
    }

    const mimeType = getMimeType(imagePath);
    if (!mimeType) {
      return { success: false, output: `browser.vision: unsupported format "${path.extname(imagePath)}". Use PNG/JPG/GIF/WEBP.` };
    }

    // Prefer the agent's own Brain (shared model routing, failover, cost tracking,
    // and access to Claude vision) before the standalone HTTP providers.
    const brain = (ctx.config as ConfigLike | undefined)?.brain;
    if (brain) {
      try {
        log.info({ question: question.slice(0, 60) }, 'Calling vision via Brain');
        const res = await brain.call({
          messages: [{
            role: 'user',
            content: question,
            images: [{ type: 'base64', data: base64, mediaType: mimeType as VisionMime }],
          }],
          model: 'auto',
          inputModalities: ['text', 'image'],
        });
        const answer = (res.content ?? '').trim();
        if (answer) {
          const truncated = answer.length > MAX_OUTPUT_CHARS ? answer.slice(0, MAX_OUTPUT_CHARS) + '\n[truncated]' : answer;
          log.info({ answerLen: answer.length }, 'Vision via Brain success');
          return { success: true, output: truncated, data: { provider: 'brain' } };
        }
        log.warn('Brain vision returned empty — falling back to HTTP providers');
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'Brain vision failed — falling back to HTTP providers');
      }
    }

    // Standalone HTTP fallback — visionIR tries xAI first, then OpenAI (gpt-4o),
    // skipping providers whose API key is not set (same ordering as before).
    try {
      log.info({ model: FALLBACK_VISION_MODEL, question: question.slice(0, 60) }, 'Calling vision API');
      const { text } = await visionIR({
        caller: 'browser-vision',
        purpose: 'screenshot analysis',
        imageUrl: `data:${mimeType};base64,${base64}`,
        prompt: question,
        alias: FALLBACK_VISION_MODEL,
        maxTokens: 1024,
      });
      const answer = text || '(no response)';
      const truncated = answer.length > MAX_OUTPUT_CHARS ? answer.slice(0, MAX_OUTPUT_CHARS) + '\n[truncated]' : answer;
      log.info({ answerLen: answer.length }, 'Vision API success');
      return { success: true, output: truncated, data: { provider: 'llm-client' } };
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Vision HTTP fallback failed');
    }

    return {
      success: false,
      output:
        'browser.vision: all vision providers failed (Brain vision call errored and no working ' +
        'XAI_API_KEY/OPENAI_API_KEY fallback). This is transient provider failure, not a missing ' +
        'capability — retry once before reporting vision as unavailable.',
    };
  },
};
