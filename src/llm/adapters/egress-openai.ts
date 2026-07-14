/**
 * @file egress-openai.ts
 * @description IR → OpenAI-compatible Chat Completions request body, plus the
 * matching response parser (gw-refactor Phase 3). Serves every OpenAI-compat
 * upstream: GLM, Kimi, DeepSeek, Ollama, LiteLLM-style gateways.
 *
 * Shape rules:
 * - IRRequest.system → messages[0] with role 'system'.
 * - tool_use blocks → assistant `tool_calls` with `arguments:
 *   JSON.stringify(input)` — the object is re-stringified at the LAST moment.
 * - tool_result blocks → role:'tool' messages; OpenAI has no error flag, so
 *   is_error is noted with a `[tool error] ` content prefix.
 * - image blocks → content-part image_url (base64 sources become data: URLs).
 * - Response parsing funnels tool arguments through parseToolArguments
 *   (JSON.parse → jsonrepair → {} + extra.parse_error).
 */

import type {
  IRRequest,
  IRResponse,
  IRMessage,
  IRContentBlock,
  IRImageBlock,
  IRToolUseBlock,
  IRToolResultBlock,
  IRUsage,
} from '../../../shared-types/ir/v1.js';
import { resolveAlias } from '../aliases.js';
import { parseToolArguments } from './tool-args.js';

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Stop-reason maps (wire ↔ IR)
// ---------------------------------------------------------------------------

/** OpenAI finish_reason → IR stop_reason. Unknown values map to 'error'. */
export function openAIFinishReasonToIR(reason: unknown): IRResponse['stop_reason'] {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
    default:
      return 'error';
  }
}

/** Reverse map for future egress of IRResponses over the OpenAI wire. */
export function irStopReasonToOpenAI(reason: IRResponse['stop_reason']): string {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'error':
      return 'content_filter';
  }
}

// ---------------------------------------------------------------------------
// Request egress
// ---------------------------------------------------------------------------

function imageBlockToPart(block: IRImageBlock): Rec {
  const src = block.source;
  const url =
    src.type === 'base64'
      ? `data:${src.media_type ?? 'image/png'};base64,${src.data ?? ''}`
      : (src.url ?? '');
  return { type: 'image_url', image_url: { url } };
}

/** tool_result content → the plain string OpenAI tool messages require. */
function toolResultToString(block: IRToolResultBlock): string {
  const body =
    typeof block.content === 'string'
      ? block.content
      : block.content
          .map((c) => (c.type === 'text' ? c.text : '[image]'))
          .join('');
  return block.is_error === true ? `[tool error] ${body}` : body;
}

/** user/assistant blocks (no tool_result / tool_use) → OpenAI content. */
function blocksToContent(blocks: IRContentBlock[]): string | Rec[] {
  const hasImage = blocks.some((b) => b.type === 'image');
  if (!hasImage) {
    return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }
  const parts: Rec[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image') parts.push(imageBlockToPart(b));
  }
  return parts;
}

function convertMessage(msg: IRMessage, out: Rec[]): void {
  if (msg.role === 'assistant') {
    const toolCalls = msg.content.filter((b): b is IRToolUseBlock => b.type === 'tool_use');
    const rest = msg.content.filter((b) => b.type !== 'tool_use' && b.type !== 'tool_result');
    const text = rest
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    const m: Rec = { role: 'assistant', content: text === '' ? null : text };
    if (toolCalls.length > 0) {
      m['tool_calls'] = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        // Re-stringify at the last moment — the IR carried a real object.
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      }));
    }
    out.push(m);
    return;
  }

  // user message: tool_result blocks become role:'tool' messages (they must
  // directly follow the assistant tool_calls turn), other blocks a user msg.
  const toolResults = msg.content.filter((b): b is IRToolResultBlock => b.type === 'tool_result');
  for (const tr of toolResults) {
    out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: toolResultToString(tr) });
  }
  const rest = msg.content.filter((b) => b.type !== 'tool_result' && b.type !== 'tool_use');
  if (rest.length > 0) {
    out.push({ role: 'user', content: blocksToContent(rest) });
  }
}

/** IRRequest → OpenAI-compatible Chat Completions request body. */
export function egressOpenAI(ir: IRRequest): Rec {
  const messages: Rec[] = [];
  if (ir.system !== undefined && ir.system !== '') {
    messages.push({ role: 'system', content: ir.system });
  }
  for (const msg of ir.messages) convertMessage(msg, messages);

  const body: Rec = { model: resolveAlias(ir.alias), messages };

  if (ir.tools !== undefined && ir.tools.length > 0) {
    body['tools'] = ir.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        parameters: t.input_schema,
      },
    }));
  }

  if (ir.response_schema !== undefined) {
    body['response_format'] = {
      type: 'json_schema',
      json_schema: { name: 'structured_output', strict: true, schema: ir.response_schema },
    };
  }

  if (ir.max_tokens !== undefined) body['max_tokens'] = ir.max_tokens;
  if (ir.temperature !== undefined) body['temperature'] = ir.temperature;
  return body;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseUsage(u: unknown): IRUsage {
  if (!isRec(u)) return { in: 0, out: 0, cached_in: 0 };
  const details = isRec(u['prompt_tokens_details']) ? u['prompt_tokens_details'] : {};
  return {
    in: typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : 0,
    out: typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : 0,
    cached_in: typeof details['cached_tokens'] === 'number' ? details['cached_tokens'] : 0,
  };
}

/**
 * OpenAI Chat Completions response JSON → IRResponse.
 * HTTP-200-but-garbage (no choices, or empty content AND no tool calls) →
 * stop_reason 'error' + extra.provider_bug=true. Never throws.
 */
export function parseOpenAIResponse(json: unknown, trace_id: string): IRResponse {
  const j: Rec = isRec(json) ? json : {};
  const usage = parseUsage(j['usage']);
  const choices = Array.isArray(j['choices']) ? j['choices'] : [];
  const choice = isRec(choices[0]) ? choices[0] : undefined;
  const message = choice !== undefined && isRec(choice['message']) ? choice['message'] : undefined;

  const blocks: IRContentBlock[] = [];
  const parseErrors: Record<string, string> = {};

  if (message !== undefined) {
    const content = message['content'];
    if (typeof content === 'string' && content !== '') {
      blocks.push({ type: 'text', text: content });
    }
    const toolCalls = Array.isArray(message['tool_calls']) ? message['tool_calls'] : [];
    for (const tc of toolCalls) {
      if (!isRec(tc)) continue;
      const fn = isRec(tc['function']) ? tc['function'] : {};
      const id = typeof tc['id'] === 'string' ? tc['id'] : '';
      const rawArgs = typeof fn['arguments'] === 'string' ? fn['arguments'] : '';
      const { input, error } = parseToolArguments(rawArgs);
      if (error !== undefined) parseErrors[id] = error;
      blocks.push({
        type: 'tool_use',
        id,
        name: typeof fn['name'] === 'string' ? fn['name'] : '',
        input,
      });
    }
  }

  const extra: Record<string, unknown> = {};
  if (Object.keys(parseErrors).length > 0) extra['parse_error'] = parseErrors;

  let stopReason: IRResponse['stop_reason'];
  if (choice === undefined || blocks.length === 0) {
    // 200-but-empty/garbage: no choices, or neither text nor tool calls.
    stopReason = 'error';
    extra['provider_bug'] = true;
  } else {
    const finish = choice['finish_reason'];
    stopReason = openAIFinishReasonToIR(finish);
    if (finish === 'content_filter') extra['reason'] = 'content_filter';
  }

  const res: IRResponse = { blocks, stop_reason: stopReason, usage, trace_id };
  if (Object.keys(extra).length > 0) res.extra = extra;
  return res;
}
