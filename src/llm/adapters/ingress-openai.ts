/**
 * @file ingress-openai.ts
 * @description OpenAI Chat Completions REQUEST body → IR (gw-refactor Phase 3).
 *
 * Shape rules:
 * - system/developer messages are concatenated into IRRequest.system
 *   (first-class field, never an IR message).
 * - assistant `tool_calls[]` become tool_use blocks; `function.arguments`
 *   (a STRING on the wire) is parsed into a real object EXACTLY ONCE here
 *   (JSON.parse → jsonrepair → `{}` + extra.parse_error, never a throw).
 * - `role:"tool"` messages are folded Anthropic-style: consecutive tool
 *   messages become ONE user message of tool_result blocks that follows the
 *   assistant turn that issued the calls. `tool_call_id` → `tool_use_id`.
 * - temperature/max_tokens map to IR fields; every other unmapped top-level
 *   field rides in `extra` untouched.
 */

import { randomUUID } from 'node:crypto';
import type {
  IRRequest,
  IRMessage,
  IRContentBlock,
  IRTool,
  IRToolResultBlock,
} from '../../../shared-types/ir/v1.js';
import { parseToolArguments } from './tool-args.js';

export interface IngressMeta {
  caller: string;
  purpose: string;
  /** Capability alias override; defaults to the body's `model` field. */
  alias?: string;
  priority?: 'user' | 'background';
  trace_id?: string;
}

/** Top-level OpenAI request fields we map onto typed IR fields (not extra). */
const MAPPED_FIELDS = new Set([
  'model',
  'messages',
  'tools',
  'response_format',
  'temperature',
  'max_tokens',
]);

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** OpenAI content part(s) → IR blocks (text + image_url supported). */
function partsToBlocks(content: unknown): IRContentBlock[] {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: IRContentBlock[] = [];
  for (const part of content) {
    if (!isRec(part)) continue;
    if (part['type'] === 'text') {
      blocks.push({ type: 'text', text: str(part['text']) });
    } else if (part['type'] === 'image_url') {
      const url = isRec(part['image_url']) ? str(part['image_url']['url']) : '';
      blocks.push({ type: 'image', source: imageSourceFromUrl(url) });
    }
  }
  return blocks;
}

/** data: URLs → base64 source; anything else → url source. */
function imageSourceFromUrl(url: string): { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: 'base64', media_type: m[1]!, data: m[2]! };
  return { type: 'url', url };
}

/** Tool-message content → tool_result content (string form). */
function toolContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (isRec(p) && p['type'] === 'text' ? str(p['text']) : ''))
      .join('');
  }
  return '';
}

/**
 * Convert an OpenAI Chat Completions request body into an IRRequest.
 * Never throws for malformed tool arguments — see extra.parse_error.
 */
export function ingressOpenAI(body: unknown, meta: IngressMeta): IRRequest {
  const b: Rec = isRec(body) ? body : {};
  const systemParts: string[] = [];
  const messages: IRMessage[] = [];
  const parseErrors: Record<string, string> = {};

  const rawMessages = Array.isArray(b['messages']) ? b['messages'] : [];
  let pendingToolResults: IRToolResultBlock[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const raw of rawMessages) {
    if (!isRec(raw)) continue;
    const role = str(raw['role']);

    if (role === 'system' || role === 'developer') {
      flushToolResults();
      const text = toolContentToString(raw['content']);
      if (text !== '') systemParts.push(text);
      continue;
    }

    if (role === 'tool') {
      // Fold into the following user message (Anthropic shape: tool results
      // ride in a user message after the assistant tool_use turn).
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: str(raw['tool_call_id']),
        content: toolContentToString(raw['content']),
      });
      continue;
    }

    flushToolResults();

    if (role === 'user') {
      const blocks = partsToBlocks(raw['content']);
      if (blocks.length > 0) messages.push({ role: 'user', content: blocks });
      continue;
    }

    if (role === 'assistant') {
      const blocks: IRContentBlock[] = partsToBlocks(raw['content']);
      const toolCalls = Array.isArray(raw['tool_calls']) ? raw['tool_calls'] : [];
      for (const tc of toolCalls) {
        if (!isRec(tc)) continue;
        const fn = isRec(tc['function']) ? tc['function'] : {};
        const id = str(tc['id']);
        const { input, error } = parseToolArguments(str(fn['arguments']));
        if (error !== undefined) parseErrors[id] = error;
        blocks.push({ type: 'tool_use', id, name: str(fn['name']), input });
      }
      if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    // Unknown role → dropped (nothing in IR can carry it).
  }
  flushToolResults();

  // tools[] → IRTool
  let tools: IRTool[] | undefined;
  if (Array.isArray(b['tools'])) {
    tools = [];
    for (const t of b['tools']) {
      if (!isRec(t) || t['type'] !== 'function' || !isRec(t['function'])) continue;
      const fn = t['function'];
      const tool: IRTool = {
        name: str(fn['name']),
        input_schema: isRec(fn['parameters']) ? fn['parameters'] : {},
      };
      if (typeof fn['description'] === 'string') tool.description = fn['description'];
      tools.push(tool);
    }
    if (tools.length === 0) tools = undefined;
  }

  // response_format json_schema → response_schema; other formats → extra.
  let responseSchema: Record<string, unknown> | undefined;
  const rf = b['response_format'];
  let rfUnmapped = false;
  if (isRec(rf)) {
    if (rf['type'] === 'json_schema' && isRec(rf['json_schema']) && isRec(rf['json_schema']['schema'])) {
      responseSchema = rf['json_schema']['schema'];
    } else {
      rfUnmapped = true;
    }
  }

  // Everything unmapped → extra.
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (MAPPED_FIELDS.has(k)) continue;
    if (k === 'response_format' && !rfUnmapped) continue;
    extra[k] = v;
  }
  if (Object.keys(parseErrors).length > 0) extra['parse_error'] = parseErrors;

  const ir: IRRequest = {
    alias: meta.alias ?? (typeof b['model'] === 'string' && b['model'] !== '' ? b['model'] : 'sudo/mid'),
    caller: meta.caller,
    purpose: meta.purpose,
    messages,
    priority: meta.priority ?? 'user',
    trace_id: meta.trace_id ?? `ing-${randomUUID()}`,
  };
  if (systemParts.length > 0) ir.system = systemParts.join('\n\n');
  if (tools !== undefined) ir.tools = tools;
  if (responseSchema !== undefined) ir.response_schema = responseSchema;
  if (typeof b['max_tokens'] === 'number') ir.max_tokens = b['max_tokens'];
  if (typeof b['temperature'] === 'number') ir.temperature = b['temperature'];
  if (Object.keys(extra).length > 0) ir.extra = extra;
  return ir;
}
