/**
 * @file vision.ts
 * @description browser.vision — analyze screenshots/images using vision AI.
 *
 * Provider priority (first available key wins):
 *   1. xAI   (XAI_API_KEY)    — grok-2-vision-1212, primary
 *   2. OpenAI (OPENAI_API_KEY) — gpt-4o, fallback
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const log = createLogger('browser:vision');

// Vision API providers — xAI first (primary), OpenAI fallback
const VISION_PROVIDERS = [
  { name: 'xai',    url: 'https://api.x.ai/v1/chat/completions',      model: 'grok-4-fast-non-reasoning', envKey: 'XAI_API_KEY'    },
  { name: 'openai', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o',                   envKey: 'OPENAI_API_KEY' },
];

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

async function callVisionApi(
  base64: string,
  mimeType: string,
  question: string,
  apiKey: string,
  apiUrl: string,
  model: string,
): Promise<string> {
  const body = {
    model,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
  };

  const controller = AbortSignal.timeout(60_000);
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: controller,
  });

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (!res.ok) {
    const errMsg = json.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Vision API error (${errMsg})`);
  }

  return json.choices?.[0]?.message?.content ?? '(no response)';
}

export const visionTool: ToolDefinition = {
  name: 'browser.vision',
  description:
    'Analyze a screenshot or image file using AI vision (xAI grok-2-vision / GPT-4o fallback). ' +
    'Pass an image path and a specific question. Returns a text answer describing visual content.',
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

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
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

    // Try each provider in priority order
    for (const provider of VISION_PROVIDERS) {
      const apiKey = process.env[provider.envKey];
      if (!apiKey) {
        log.debug({ provider: provider.name }, 'Vision provider skipped — API key not set');
        continue;
      }

      try {
        log.info({ provider: provider.name, model: provider.model, question: question.slice(0, 60) }, 'Calling vision API');
        const answer = await callVisionApi(base64, mimeType, question, apiKey, provider.url, provider.model);
        const truncated = answer.length > MAX_OUTPUT_CHARS ? answer.slice(0, MAX_OUTPUT_CHARS) + '\n[truncated]' : answer;
        log.info({ provider: provider.name, answerLen: answer.length }, 'Vision API success');
        return { success: true, output: truncated, data: { provider: provider.name, model: provider.model } };
      } catch (err) {
        log.warn({ provider: provider.name, err: (err as Error).message }, 'Vision provider failed — trying next');
      }
    }

    return { success: false, output: 'browser.vision: all vision providers failed. Set XAI_API_KEY or OPENAI_API_KEY.' };
  },
};
