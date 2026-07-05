/**
 * super.translate — Multi-language translation via the SUDO-AI brain (LLM).
 *
 * Preserves code blocks, markdown formatting, and inline code during translation.
 * Auto-detects source language when not specified.
 */

import { createLogger } from '../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../tools/types.js';
import { normalizeBrainText, type ToolBrain } from '../brain/brain-text.js';

const logger = createLogger('super.translate');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConfigLike {
  brain?: ToolBrain;
}

// ---------------------------------------------------------------------------
// Formatting preservation
// ---------------------------------------------------------------------------

interface ExtractedBlock { placeholder: string; content: string }

function extractBlocks(text: string): { sanitized: string; blocks: ExtractedBlock[] } {
  const blocks: ExtractedBlock[] = [];
  let idx = 0;

  // Extract fenced code blocks (``` ... ```)
  const sanitized = text.replace(/```[\s\S]*?```/g, (match) => {
    const placeholder = `__CODE_BLOCK_${idx++}__`;
    blocks.push({ placeholder, content: match });
    return placeholder;
  // Extract inline code (`...`)
  }).replace(/`[^`]+`/g, (match) => {
    const placeholder = `__INLINE_CODE_${idx++}__`;
    blocks.push({ placeholder, content: match });
    return placeholder;
  });

  return { sanitized, blocks };
}

function restoreBlocks(translated: string, blocks: ExtractedBlock[]): string {
  let result = translated;
  for (const { placeholder, content } of blocks) {
    result = result.replace(placeholder, () => content);
  }
  return result;
}

// ---------------------------------------------------------------------------
// LLM translation
// ---------------------------------------------------------------------------

async function translateWithBrain(
  text: string,
  from: string | undefined,
  to: string,
  preserveFormatting: boolean,
  ctx: ToolContext,
): Promise<string> {
  const config = ctx.config as ConfigLike | undefined;

  // Check if brain is available
  if (!config?.brain) {
    throw new Error('Brain (LLM) is not available in the current context. Ensure the brain module is configured.');
  }

  const { sanitized, blocks } = preserveFormatting ? extractBlocks(text) : { sanitized: text, blocks: [] };

  const fromClause = from ? `from ${from}` : '(auto-detect source language)';
  const formatNote = preserveFormatting && blocks.length > 0
    ? '\nIMPORTANT: The text contains placeholders like __CODE_BLOCK_0__ and __INLINE_CODE_1__. Do NOT translate these — keep them exactly as-is in your output.'
    : '';

  const prompt = `Translate the following text ${fromClause} to ${to}.${formatNote}
Return ONLY the translated text with no explanations, notes, or preamble.

Text to translate:
${sanitized}`;

  const response = await config.brain.chat([
    { role: 'system', content: 'You are an expert multilingual translator. Translate accurately and naturally.' },
    { role: 'user', content: prompt },
  ]);

  const translated = normalizeBrainText(response).trim();
  return preserveFormatting ? restoreBlocks(translated, blocks) : translated;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const translateTool: ToolDefinition = {
  name: 'super.translate',
  description: 'Translate text to any language using the AI brain. Auto-detects source language. Preserves code blocks and markdown formatting.',
  category: 'superpowers',
  timeout: 60_000,
  parameters: {
    text: { type: 'string', description: 'Text to translate.', required: true },
    from: { type: 'string', description: 'Source language (e.g. "English", "Spanish"). Auto-detected if omitted.' },
    to: { type: 'string', description: 'Target language (e.g. "French", "Japanese", "Hindi").', required: true },
    preserveFormatting: {
      type: 'boolean',
      description: 'When true, code blocks and inline code are preserved without translation.',
      default: true,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const text = params['text'] as string | undefined;
    const from = params['from'] as string | undefined;
    const to = params['to'] as string | undefined;
    const preserveFormatting = (params['preserveFormatting'] as boolean | undefined) ?? true;

    if (!text || typeof text !== 'string' || text.trim() === '') {
      return { success: false, output: 'text is required and must not be empty.' };
    }
    if (!to || typeof to !== 'string') {
      return { success: false, output: 'to (target language) is required.' };
    }

    logger.info({
      session: ctx.sessionId,
      from: from ?? 'auto',
      to,
      charCount: text.length,
      preserveFormatting,
    }, 'Translation started');

    try {
      const translated = await translateWithBrain(text, from, to, preserveFormatting, ctx);

      logger.info({ to, charCount: translated.length }, 'Translation complete');

      return {
        success: true,
        output: translated,
        data: {
          original: text,
          translated,
          from: from ?? 'auto-detected',
          to,
          preserveFormatting,
          originalLength: text.length,
          translatedLength: translated.length,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ to, err: msg }, 'Translation failed');
      return { success: false, output: `Translation failed: ${msg}` };
    }
  },
};
