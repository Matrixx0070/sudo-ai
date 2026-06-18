/**
 * Chat completion request handlers for the SUDO-AI HTTP API.
 *
 * Separated from http-server.ts to keep file sizes under 300 lines.
 * Exports non-streaming and streaming handler functions.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type { Brain } from '../brain/brain.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from './types.js';
import type { BrainMessage } from '../brain/types.js';
import type { ToolSchema } from '../tools/types.js';

const log = createLogger('api:handlers');

// ---------------------------------------------------------------------------
// Finish reason mapping
// ---------------------------------------------------------------------------

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'stop',
  'tool-calls': 'tool_calls',
  length: 'length',
  'content-filter': 'content_filter',
  error: 'stop',
};

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Convert OpenAI-compatible ChatMessage array to BrainMessage array.
 */
export function toBrainMessages(messages: ChatCompletionRequest['messages']): BrainMessage[] {
  return messages.map((m) => ({
    role: m.role as BrainMessage['role'],
    content: m.content,
    toolCallId: m.tool_call_id,
    toolCalls: m.tool_calls as BrainMessage['toolCalls'],
  }));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a ChatCompletionRequest body.
 * Returns a human-readable error string or null if valid.
 */
export function validateChatRequest(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  const b = body as Record<string, unknown>;
  if (!b['model'] || typeof b['model'] !== 'string') {
    return '"model" is required and must be a string';
  }
  if (!Array.isArray(b['messages']) || (b['messages'] as unknown[]).length === 0) {
    return '"messages" must be a non-empty array';
  }
  for (const msg of b['messages'] as unknown[]) {
    if (typeof msg !== 'object' || msg === null) return 'Each message must be an object';
    const m = msg as Record<string, unknown>;
    if (!m['role'] || typeof m['role'] !== 'string') return 'Each message must have a "role" string';
    if (!m['content'] || typeof m['content'] !== 'string') return 'Each message must have a "content" string';
  }
  return null;
}

/**
 * Whitelist-coerce an untrusted `tools` array from a chat-completion request
 * into typed `ToolSchema[]`. Each element must shape-match the registry's
 * emitted contract (`type: 'function'` + `function.name` + `function.parameters`);
 * elements that don't are dropped with a debug log instead of poisoning the
 * Brain call. Returns undefined when the input is undefined OR when zero
 * elements survived the filter — both indicate "no tools to forward".
 *
 * Replaces the `as ToolSchema[] | undefined` boundary cast that PR #204
 * carved out as a LOW: `body.tools` is typed `unknown[]` at the HTTP edge,
 * so the cast was unchecked and a malformed tools entry would surface as a
 * Brain.call() crash rather than a clean drop.
 */
export function coerceToolSchemas(input: unknown): ToolSchema[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: ToolSchema[] = [];
  for (const item of input) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    if (t['type'] !== 'function') continue;
    const fn = t['function'];
    if (typeof fn !== 'object' || fn === null) continue;
    const f = fn as Record<string, unknown>;
    if (typeof f['name'] !== 'string' || f['name'].length === 0) continue;
    if (typeof f['description'] !== 'string') continue;
    if (typeof f['parameters'] !== 'object' || f['parameters'] === null) continue;
    out.push(item as ToolSchema);
  }
  if (out.length === 0) return undefined;
  if (out.length !== input.length) {
    log.debug({ kept: out.length, dropped: input.length - out.length }, 'coerceToolSchemas: dropped malformed entries');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Non-streaming handler
// ---------------------------------------------------------------------------

/**
 * Handle a non-streaming POST /v1/chat/completions request.
 * Calls Brain.call() and serialises the result as ChatCompletionResponse.
 */
export async function handleNonStreaming(
  res: http.ServerResponse,
  brain: Brain,
  body: ChatCompletionRequest,
  sendJson: (res: http.ServerResponse, status: number, data: unknown) => void,
  sendError: (res: http.ServerResponse, status: number, message: string) => void,
): Promise<void> {
  const brainMessages = toBrainMessages(body.messages);

  let brainRes;
  try {
    brainRes = await brain.call({
      messages: brainMessages,
      source: 'api',
      model: body.model,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      tools: coerceToolSchemas(body.tools),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Brain.call() failed');
    sendError(res, 500, `LLM call failed: ${msg}`);
    return;
  }

  const response: ChatCompletionResponse = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: brainRes.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: brainRes.content,
          tool_calls: brainRes.toolCalls.length > 0 ? brainRes.toolCalls : undefined,
        },
        finish_reason: FINISH_REASON_MAP[brainRes.finishReason] ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: brainRes.usage.promptTokens,
      completion_tokens: brainRes.usage.completionTokens,
      total_tokens: brainRes.usage.totalTokens,
    },
  };

  sendJson(res, 200, response);
}

// ---------------------------------------------------------------------------
// Streaming handler
// ---------------------------------------------------------------------------

/**
 * Handle a streaming POST /v1/chat/completions request.
 * Calls Brain.stream() and writes SSE chunks.
 */
export async function handleStreaming(
  res: http.ServerResponse,
  brain: Brain,
  body: ChatCompletionRequest,
): Promise<void> {
  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const brainMessages = toBrainMessages(body.messages);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendChunk = (delta: { role?: string; content?: string }, finishReason: string | null): void => {
    const chunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  // Initial role announcement.
  sendChunk({ role: 'assistant', content: '' }, null);

  try {
    for await (const chunk of brain.stream({
      messages: brainMessages,
      model: body.model,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      tools: coerceToolSchemas(body.tools),
    })) {
      sendChunk({ content: chunk }, null);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Brain.stream() failed during SSE');
    sendChunk({ content: `\n[Error: ${msg}]` }, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  sendChunk({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}
