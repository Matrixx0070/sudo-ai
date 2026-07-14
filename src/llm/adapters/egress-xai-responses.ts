/**
 * @file egress-xai-responses.ts
 * @description IR → xAI Responses-style API request body, plus the matching
 * response parser and SSE machine (xai-oauth Phase 2). xAI's /v1/responses
 * mirrors the OpenAI Responses API; subscription OAuth Grok is only served on
 * this endpoint, so the `xai-oauth/` provider family rides this adapter.
 *
 * Shape rules:
 * - IRRequest.system → input[0] as a role:'system' message item (the Responses
 *   spec also offers top-level `instructions`; a system input item is what the
 *   OpenAI SDK emits for converted chat history and survives replay verbatim).
 * - user text/images → {role:'user', content:[{type:'input_text'|'input_image'}]}.
 * - assistant text → {role:'assistant', content:[{type:'output_text', text}]}.
 * - tool_use → top-level {type:'function_call', call_id, name, arguments} items
 *   (arguments re-stringified at the last moment — the IR carries an object).
 * - tool_result → {type:'function_call_output', call_id, output} items.
 * - thinking blocks (and any reasoning items) are STRIPPED from replayed
 *   history (operator gotcha 2: replaying encrypted reasoning items to
 *   /responses returns 400). On the way OUT, response reasoning items ARE
 *   mapped into IR thinking blocks — strip happens only on the way back in.
 * - IR tools → flat Responses tools [{type:'function', name, description,
 *   parameters}] (NOT the Chat Completions nested `function` wrapper).
 * - response_schema → text.format json_schema (Responses structured-output
 *   spec: text: {format: {type:'json_schema', name, strict, schema}}).
 *   UNVERIFIED against xAI live — documented in docs/providers/xai-oauth.md.
 * - Response parsing funnels function_call arguments through
 *   parseToolArguments (the single parse-once funnel).
 */

import type {
  IRRequest,
  IRResponse,
  IRMessage,
  IRContentBlock,
  IRImageBlock,
  IRToolResultBlock,
  IRUsage,
} from '../../../shared-types/ir/v1.js';
import { resolveAlias } from '../aliases.js';
import { parseToolArguments } from './tool-args.js';
import type { IRStreamEvent, IRStreamMachine } from './stream.js';

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
  return { type: 'input_image', image_url: url };
}

/** tool_result content → the plain string function_call_output requires. */
function toolResultToString(block: IRToolResultBlock): string {
  const body =
    typeof block.content === 'string'
      ? block.content
      : block.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('');
  return block.is_error === true ? `[tool error] ${body}` : body;
}

function convertMessage(msg: IRMessage, out: Rec[]): void {
  if (msg.role === 'assistant') {
    // thinking blocks are STRIPPED on replay (gotcha 2 — see file header).
    const textParts: Rec[] = [];
    for (const b of msg.content) {
      if (b.type === 'text') {
        textParts.push({ type: 'output_text', text: b.text });
      } else if (b.type === 'tool_use') {
        // Flush any accumulated text as its own assistant message item so
        // item ordering (text before the call) is preserved.
        if (textParts.length > 0) {
          out.push({ role: 'assistant', content: [...textParts] });
          textParts.length = 0;
        }
        out.push({
          type: 'function_call',
          call_id: b.id,
          name: b.name,
          // Re-stringify at the last moment — the IR carried a real object.
          arguments: JSON.stringify(b.input),
        });
      }
      // thinking / tool_result / image inside assistant turns: skipped.
    }
    if (textParts.length > 0) out.push({ role: 'assistant', content: textParts });
    return;
  }

  // user message: tool_result blocks become function_call_output items (they
  // must follow the assistant function_call items), other blocks a user item.
  const parts: Rec[] = [];
  for (const b of msg.content) {
    if (b.type === 'tool_result') {
      out.push({ type: 'function_call_output', call_id: b.tool_use_id, output: toolResultToString(b) });
    } else if (b.type === 'text') {
      parts.push({ type: 'input_text', text: b.text });
    } else if (b.type === 'image') {
      parts.push(imageBlockToPart(b));
    }
  }
  if (parts.length > 0) out.push({ role: 'user', content: parts });
}

/** IRRequest → xAI Responses API request body. */
export function egressXaiResponses(ir: IRRequest): Rec {
  const input: Rec[] = [];
  if (ir.system !== undefined && ir.system !== '') {
    input.push({ role: 'system', content: [{ type: 'input_text', text: ir.system }] });
  }
  for (const msg of ir.messages) convertMessage(msg, input);

  const body: Rec = { model: resolveAlias(ir.alias), input };

  if (ir.tools !== undefined && ir.tools.length > 0) {
    // Responses tools are FLAT (no Chat-Completions `function` wrapper).
    body['tools'] = ir.tools.map((t) => ({
      type: 'function',
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: t.input_schema,
    }));
  }

  if (ir.response_schema !== undefined) {
    body['text'] = {
      format: {
        type: 'json_schema',
        name: 'structured_output',
        strict: true,
        schema: ir.response_schema,
      },
    };
  }

  if (ir.max_tokens !== undefined) body['max_output_tokens'] = ir.max_tokens;
  if (ir.temperature !== undefined) body['temperature'] = ir.temperature;
  return body;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseUsage(u: unknown): IRUsage {
  if (!isRec(u)) return { in: 0, out: 0, cached_in: 0 };
  const details = isRec(u['input_tokens_details']) ? u['input_tokens_details'] : {};
  return {
    in: typeof u['input_tokens'] === 'number' ? u['input_tokens'] : 0,
    out: typeof u['output_tokens'] === 'number' ? u['output_tokens'] : 0,
    cached_in: typeof details['cached_tokens'] === 'number' ? details['cached_tokens'] : 0,
  };
}

/** reasoning item → thinking text (summary_text parts + content text parts). */
function reasoningText(item: Rec): string {
  const parts: string[] = [];
  for (const key of ['summary', 'content'] as const) {
    const arr = item[key];
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      if (isRec(p) && typeof p['text'] === 'string' && p['text'] !== '') parts.push(p['text']);
    }
  }
  return parts.join('\n');
}

/**
 * xAI Responses API response JSON → IRResponse.
 * output[] items: message/output_text → text blocks; function_call → tool_use
 * (arguments through the parse-once funnel); reasoning → thinking blocks
 * (mapped INTO the IR — they are stripped only on replay). status maps:
 * completed → end_turn | tool_use (when a function_call is present);
 * incomplete + max_output_tokens → max_tokens; failed → error + extra.
 * 200-but-empty → stop_reason 'error' + extra.provider_bug. Never throws.
 */
export function parseXaiResponsesResponse(json: unknown, trace_id: string): IRResponse {
  const j: Rec = isRec(json) ? json : {};
  const usage = parseUsage(j['usage']);
  const output = Array.isArray(j['output']) ? j['output'] : [];

  const blocks: IRContentBlock[] = [];
  const parseErrors: Record<string, string> = {};
  let sawFunctionCall = false;

  for (const raw of output) {
    if (!isRec(raw)) continue;
    const type = raw['type'];
    if (type === 'message') {
      const content = Array.isArray(raw['content']) ? raw['content'] : [];
      for (const part of content) {
        if (isRec(part) && part['type'] === 'output_text' && typeof part['text'] === 'string' && part['text'] !== '') {
          blocks.push({ type: 'text', text: part['text'] });
        }
      }
    } else if (type === 'function_call') {
      sawFunctionCall = true;
      const callId = typeof raw['call_id'] === 'string' ? raw['call_id'] : '';
      const rawArgs = typeof raw['arguments'] === 'string' ? raw['arguments'] : '';
      const { input, error } = parseToolArguments(rawArgs);
      if (error !== undefined) parseErrors[callId] = error;
      blocks.push({
        type: 'tool_use',
        id: callId,
        name: typeof raw['name'] === 'string' ? raw['name'] : '',
        input,
      });
    } else if (type === 'reasoning') {
      const text = reasoningText(raw);
      if (text !== '') blocks.push({ type: 'thinking', thinking: text });
    }
    // encrypted-only reasoning / unknown item types are dropped from the
    // typed surface (they must never be replayed anyway — gotcha 2).
  }

  const extra: Record<string, unknown> = {};
  if (Object.keys(parseErrors).length > 0) extra['parse_error'] = parseErrors;

  // A reasoning-only response is still empty from the consumer's viewpoint.
  const hasContent = blocks.some((b) => b.type === 'text' || b.type === 'tool_use');

  let stopReason: IRResponse['stop_reason'];
  const status = j['status'];
  if (status === 'failed' || status === 'cancelled') {
    stopReason = 'error';
    const err = isRec(j['error']) ? j['error'] : {};
    extra['reason'] = typeof err['message'] === 'string' ? err['message'] : String(status);
  } else if (status === 'incomplete') {
    const inc = isRec(j['incomplete_details']) ? j['incomplete_details'] : {};
    stopReason = inc['reason'] === 'max_output_tokens' ? 'max_tokens' : 'error';
    if (stopReason === 'error') {
      extra['reason'] = typeof inc['reason'] === 'string' ? inc['reason'] : 'incomplete';
    }
  } else if (!hasContent) {
    // 200-but-empty (completed/unknown status with no text and no calls).
    stopReason = 'error';
    extra['provider_bug'] = true;
  } else {
    stopReason = sawFunctionCall ? 'tool_use' : 'end_turn';
  }

  const res: IRResponse = { blocks, stop_reason: stopReason, usage, trace_id };
  if (Object.keys(extra).length > 0) res.extra = extra;
  return res;
}

// ---------------------------------------------------------------------------
// SSE machine (Responses streaming events)
// ---------------------------------------------------------------------------

interface PendingCall {
  id: string;
  name: string;
  json: string;
  /** function_call_arguments deltas already emitted item-final via item.done. */
  done: boolean;
}

function finishCall(t: PendingCall): IRStreamEvent {
  const { input, error } = parseToolArguments(t.json);
  const ev: IRStreamEvent = { type: 'tool_use_end', id: t.id, name: t.name, input };
  if (error !== undefined) (ev as { parse_error?: string }).parse_error = error;
  return ev;
}

/**
 * Single-use SSE→IR state machine for xAI Responses streaming events —
 * IDENTICAL contract to the machines in stream.ts (RULE 4: firstTokenEmitted
 * retry gate, terminal message_end, push()/end()/fail(), input after terminal
 * throws).
 *
 * Event map:
 * - response.output_item.added (item.type function_call) → tool_use_start
 * - response.output_text.delta                            → text_delta
 * - response.function_call_arguments.delta                → tool_input_delta
 * - response.output_item.done (item.type function_call)   → tool_use_end
 * - response.completed / response.incomplete              → message_end (usage
 *   + stop_reason from the embedded response object) — the IN-BAND terminal.
 * - response.failed / error                               → stream_error +
 *   terminal message_end {stop_reason:'error'}.
 */
export function createXaiResponsesSSEMachine(): IRStreamMachine {
  /** function_call accumulation keyed by output_index. */
  const pending = new Map<number, PendingCall>();
  let usage: IRUsage = { in: 0, out: 0, cached_in: 0 };
  let sawFunctionCall = false;
  let firstTokenEmitted = false;
  let terminated = false;

  const emit = (events: IRStreamEvent[]): IRStreamEvent[] => {
    if (events.length > 0) firstTokenEmitted = true;
    if (events.some((e) => e.type === 'message_end')) terminated = true;
    return events;
  };

  const flushPending = (): IRStreamEvent[] => {
    const out: IRStreamEvent[] = [];
    for (const [, t] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      if (!t.done) out.push(finishCall(t));
    }
    pending.clear();
    return out;
  };

  const terminal = (stop: IRResponse['stop_reason']): IRStreamEvent => ({
    type: 'message_end',
    stop_reason: stop,
    usage,
  });

  const consume = (event: unknown): IRStreamEvent[] => {
    if (!isRec(event)) return [];
    const out: IRStreamEvent[] = [];
    const type = event['type'];

    switch (type) {
      case 'response.output_item.added': {
        const item = isRec(event['item']) ? event['item'] : {};
        if (item['type'] === 'function_call') {
          const idx = typeof event['output_index'] === 'number' ? event['output_index'] : pending.size;
          const t: PendingCall = {
            id: typeof item['call_id'] === 'string' ? item['call_id'] : `call_${idx}`,
            name: typeof item['name'] === 'string' ? item['name'] : '',
            json: typeof item['arguments'] === 'string' ? item['arguments'] : '',
            done: false,
          };
          pending.set(idx, t);
          out.push({ type: 'tool_use_start', id: t.id, name: t.name });
        }
        break;
      }
      case 'response.output_text.delta': {
        if (typeof event['delta'] === 'string' && event['delta'] !== '') {
          out.push({ type: 'text_delta', text: event['delta'] });
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const idx = typeof event['output_index'] === 'number' ? event['output_index'] : 0;
        const t = pending.get(idx);
        if (t !== undefined && typeof event['delta'] === 'string' && event['delta'] !== '') {
          t.json += event['delta'];
          out.push({ type: 'tool_input_delta', id: t.id, partial_json: event['delta'] });
        }
        break;
      }
      case 'response.output_item.done': {
        const item = isRec(event['item']) ? event['item'] : {};
        if (item['type'] === 'function_call') {
          sawFunctionCall = true;
          const idx = typeof event['output_index'] === 'number' ? event['output_index'] : 0;
          const t = pending.get(idx);
          if (t !== undefined) {
            // The done item carries the authoritative final arguments string.
            if (typeof item['arguments'] === 'string' && item['arguments'] !== '') {
              t.json = item['arguments'];
            }
            if (typeof item['call_id'] === 'string' && item['call_id'] !== '') t.id = item['call_id'];
            if (typeof item['name'] === 'string' && item['name'] !== '') t.name = item['name'];
            t.done = true;
            out.push(finishCall(t));
          }
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const resp = isRec(event['response']) ? event['response'] : {};
        usage = parseUsage(resp['usage']);
        out.push(...flushPending());
        let stop: IRResponse['stop_reason'];
        if (type === 'response.incomplete') {
          const inc = isRec(resp['incomplete_details']) ? resp['incomplete_details'] : {};
          stop = inc['reason'] === 'max_output_tokens' ? 'max_tokens' : 'error';
        } else {
          stop = sawFunctionCall || out.some((e) => e.type === 'tool_use_end') ? 'tool_use' : 'end_turn';
        }
        out.push(terminal(stop));
        break;
      }
      case 'response.failed': {
        const resp = isRec(event['response']) ? event['response'] : {};
        const err = isRec(resp['error']) ? resp['error'] : {};
        const msg = typeof err['message'] === 'string' ? err['message'] : 'xai responses stream failed';
        const u = resp['usage'];
        if (u !== undefined) usage = parseUsage(u);
        out.push({ type: 'stream_error', error: msg });
        out.push(terminal('error'));
        break;
      }
      case 'error': {
        const msg = typeof event['message'] === 'string' ? event['message'] : 'xai responses stream error';
        out.push({ type: 'stream_error', error: msg });
        out.push(terminal('error'));
        break;
      }
      default:
        // response.created / in_progress / *.done text events / reasoning
        // deltas etc. carry no IR-visible information — ignored.
        break;
    }
    return out;
  };

  return {
    get firstTokenEmitted() {
      return firstTokenEmitted;
    },
    get terminated() {
      return terminated;
    },
    get partialUsage(): IRUsage {
      return { ...usage };
    },
    push(event: unknown): IRStreamEvent[] {
      if (terminated) {
        throw new Error('IR stream machine is single-use: received input after terminal message_end (RULE 4)');
      }
      return emit(consume(event));
    },
    end(): IRStreamEvent[] {
      if (terminated) return [];
      // Truncation flush: stream closed without response.completed.
      const stop = sawFunctionCall ? 'tool_use' : 'end_turn';
      return emit([...flushPending(), terminal(stop)]);
    },
    fail(error: string): IRStreamEvent[] {
      if (terminated) return [];
      return emit([{ type: 'stream_error', error }, terminal('error')]);
    },
  };
}
