/**
 * @file content-types.ts
 * @description Rich structured content types for SUDO-AI agent responses.
 *
 * Based on ChatGPT's multi-block content model. Instead of a plain string,
 * agent responses can carry typed blocks — code, reasoning, tool output,
 * errors, progress — allowing consumers to render each block appropriately.
 */

import { createLogger } from '../shared/logger.js';
import type { BrainResponse } from './loop-helpers.js';

const log = createLogger('agent:content-types');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Discriminated content type for a single block within a rich response.
 *
 * - text             Plain narrative response
 * - code             Code block with optional language tag
 * - thoughts         Internal chain-of-thought reasoning (may be hidden in UI)
 * - reasoning_recap  Summary of the reasoning that produced the answer
 * - execution_output Raw stdout / stderr from a tool or command
 * - error            Error message (tool failure, model error, etc.)
 * - system_info      System status, health, or debug information
 * - search_result    Structured web search result
 * - file_change      File creation or modification record
 * - progress         In-progress task update with percentage / description
 */
export type ContentType =
  | 'text'
  | 'code'
  | 'thoughts'
  | 'reasoning_recap'
  | 'execution_output'
  | 'error'
  | 'system_info'
  | 'search_result'
  | 'file_change'
  | 'progress';

/** A single typed content block within a rich response. */
export interface ContentBlock {
  /** Semantic type of this block. */
  type: ContentType;
  /** The block content as a string. For code blocks this is the source. */
  content: string;
  /** Optional structured metadata (language for code, url for search, etc.). */
  metadata?: Record<string, unknown>;
  /** ISO-8601 timestamp when this block was produced. */
  timestamp: string;
}

/**
 * A complete rich response composed of ordered content blocks.
 * Emitted by the agent loop instead of a plain string when full block
 * decomposition is needed.
 */
export interface RichResponse {
  /** Ordered array of typed content blocks. */
  blocks: ContentBlock[];
  /** Provider-qualified model that produced the response (e.g. "xai/grok-3-fast"). */
  model: string;
  /** Optional reasoning level label (e.g. "high", "medium", "low"). */
  reasoningLevel?: string;
  /** Total tokens used, if reported by the provider. */
  tokensUsed?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a ContentBlock with the current ISO timestamp.
 *
 * @param type     - Content type discriminant.
 * @param content  - Block content string.
 * @param metadata - Optional extra metadata.
 */
export function makeBlock(
  type: ContentType,
  content: string,
  metadata?: Record<string, unknown>,
): ContentBlock {
  return {
    type,
    content,
    metadata,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Code block detection
// ---------------------------------------------------------------------------

const CODE_FENCE_RE = /```(\w+)?\n?([\s\S]*?)```/g;

/**
 * Detect inline code fences and extract them as code blocks.
 * Returns an array of [language, code] pairs; language may be empty string.
 *
 * @internal
 */
function extractCodeFences(text: string): Array<{ lang: string; code: string }> {
  const results: Array<{ lang: string; code: string }> = [];
  let match: RegExpExecArray | null;
  CODE_FENCE_RE.lastIndex = 0;
  while ((match = CODE_FENCE_RE.exec(text)) !== null) {
    results.push({ lang: match[1] ?? '', code: (match[2] ?? '').trim() });
  }
  return results;
}

// ---------------------------------------------------------------------------
// BrainResponse -> ContentBlock[] conversion
// ---------------------------------------------------------------------------

/**
 * Convert a raw BrainResponse into an ordered array of ContentBlock objects.
 *
 * Algorithm:
 *  1. If the response content contains code fences, split into text + code blocks.
 *  2. The model identifier is stored on the RichResponse wrapper, not the blocks.
 *  3. Tool call information is captured as execution_output blocks (summary only).
 *
 * @param response - BrainResponse from the agent loop.
 * @returns Ordered ContentBlock array ready for RichResponse.blocks.
 */
export function buildContentBlocks(response: BrainResponse): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const ts = new Date().toISOString();

  if (!response.content && response.toolCalls.length === 0) {
    log.warn({ model: response.model }, 'buildContentBlocks: empty response — returning empty blocks');
    return blocks;
  }

  // Split the main content on code fences.
  if (response.content) {
    const raw = response.content;
    let lastIndex = 0;
    CODE_FENCE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = CODE_FENCE_RE.exec(raw)) !== null) {
      // Text before this code fence.
      const before = raw.slice(lastIndex, match.index).trim();
      if (before) {
        blocks.push({ type: 'text', content: before, timestamp: ts });
      }
      // The code fence itself.
      const lang = match[1] ?? '';
      const code = (match[2] ?? '').trim();
      blocks.push({
        type: 'code',
        content: code,
        metadata: lang ? { language: lang } : undefined,
        timestamp: ts,
      });
      lastIndex = match.index + match[0].length;
    }

    // Remaining text after the last code fence.
    const tail = raw.slice(lastIndex).trim();
    if (tail) {
      blocks.push({ type: 'text', content: tail, timestamp: ts });
    }

    // If no code fences were found, emit a single text block.
    if (blocks.length === 0 && raw.trim()) {
      blocks.push({ type: 'text', content: raw.trim(), timestamp: ts });
    }
  }

  // Summarise tool calls as execution_output blocks.
  for (const tc of response.toolCalls) {
    blocks.push({
      type: 'execution_output',
      content: `Tool called: ${tc.name}`,
      metadata: { toolCallId: tc.id, arguments: tc.arguments },
      timestamp: ts,
    });
  }

  log.debug({ blockCount: blocks.length, model: response.model }, 'Content blocks built');
  return blocks;
}

/**
 * Wrap a ContentBlock array and BrainResponse metadata into a RichResponse.
 *
 * @param blocks   - Pre-built content blocks.
 * @param response - Original BrainResponse for model / token metadata.
 */
export function toRichResponse(blocks: ContentBlock[], response: BrainResponse): RichResponse {
  const rich: RichResponse = {
    blocks,
    model: response.model,
  };

  const totalTokens = response.usage?.totalTokens;
  if (typeof totalTokens === 'number' && totalTokens > 0) {
    rich.tokensUsed = totalTokens;
  }

  return rich;
}
