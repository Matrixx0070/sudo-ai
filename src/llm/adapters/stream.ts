/**
 * @file stream.ts
 * @description Streaming: provider SSE event objects → typed IRStreamEvents
 * (gw-refactor Phase 3). Pure state machines — NO fetch/transport here, which
 * is what makes them golden-testable; the future transport feeds parsed SSE
 * event objects in and forwards the emitted IRStreamEvents.
 *
 * RULE 4 — retry discipline (documented + enforced):
 * - The machine exposes `firstTokenEmitted`. The transport may retry the
 *   upstream call ONLY while `firstTokenEmitted === false`.
 * - After the first emitted event, on upstream failure the transport calls
 *   `fail()`, which emits {type:'stream_error'} followed by a message_end with
 *   stop_reason 'error' — and the machine MUST NOT restart.
 * - Enforcement: machines are single-use. Feeding `push()` (or `fail()`/`end()`
 *   producing events) after the terminal message_end throws.
 */

import type { IRResponse, IRUsage } from '../../../shared-types/ir/v1.js';
import { parseToolArguments } from './tool-args.js';
import { openAIFinishReasonToIR } from './egress-openai.js';
import { anthropicStopReasonToIR } from './egress-anthropic.js';

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Event union
// ---------------------------------------------------------------------------

export type IRStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partial_json: string }
  | {
      type: 'tool_use_end';
      id: string;
      name: string;
      /** Accumulated partials parsed ONCE (jsonrepair fallback) — real object. */
      input: Record<string, unknown>;
      parse_error?: string;
    }
  | { type: 'message_end'; stop_reason: IRResponse['stop_reason']; usage: IRUsage }
  | { type: 'stream_error'; error: string };

export interface IRStreamMachine {
  /** True once ANY event has been emitted — the transport's retry gate (RULE 4). */
  readonly firstTokenEmitted: boolean;
  /** True after the terminal message_end; the machine is spent. */
  readonly terminated: boolean;
  /**
   * Last-known usage snapshot (copy). Anthropic message_start already carries
   * input_tokens, so a cancelled stream still knows its prompt cost — the
   * transport reads this for partial llm_calls rows and cancelled-stream
   * billing (never undefined; zeros until the wire reports anything).
   */
  readonly partialUsage: IRUsage;
  /** Feed one parsed SSE event/chunk object; returns 0..n IR stream events. */
  push(event: unknown): IRStreamEvent[];
  /**
   * Transport signals the stream closed (e.g. OpenAI `[DONE]`). Emits the
   * terminal message_end if one has not been emitted yet; no-op afterwards.
   */
  end(): IRStreamEvent[];
  /**
   * Upstream failure AFTER first token: emits stream_error + terminal
   * message_end with stop_reason 'error'. No-op if already terminated.
   */
  fail(error: string): IRStreamEvent[];
}

/** Get a fresh single-use SSE→IR state machine for the given wire format. */
export function streamIR(target: 'openai' | 'anthropic'): IRStreamMachine {
  return target === 'anthropic' ? parseAnthropicSSE() : parseOpenAISSE();
}

// ---------------------------------------------------------------------------
// Shared base: single-use + first-token bookkeeping
// ---------------------------------------------------------------------------

interface PendingTool {
  id: string;
  name: string;
  json: string;
}

function finishTool(t: PendingTool): IRStreamEvent {
  const { input, error } = parseToolArguments(t.json);
  const ev: IRStreamEvent = { type: 'tool_use_end', id: t.id, name: t.name, input };
  if (error !== undefined) (ev as { parse_error?: string }).parse_error = error;
  return ev;
}

abstract class BaseMachine implements IRStreamMachine {
  firstTokenEmitted = false;
  terminated = false;
  protected usage: IRUsage = { in: 0, out: 0, cached_in: 0 };
  protected stopReason: IRResponse['stop_reason'] = 'end_turn';

  get partialUsage(): IRUsage {
    return { ...this.usage };
  }

  protected emit(events: IRStreamEvent[]): IRStreamEvent[] {
    if (events.length > 0) this.firstTokenEmitted = true;
    if (events.some((e) => e.type === 'message_end')) this.terminated = true;
    return events;
  }

  protected assertLive(): void {
    if (this.terminated) {
      throw new Error('IR stream machine is single-use: received input after terminal message_end (RULE 4)');
    }
  }

  push(event: unknown): IRStreamEvent[] {
    this.assertLive();
    return this.emit(this.consume(event));
  }

  end(): IRStreamEvent[] {
    if (this.terminated) return [];
    return this.emit([...this.flushPending(), { type: 'message_end', stop_reason: this.stopReason, usage: this.usage }]);
  }

  fail(error: string): IRStreamEvent[] {
    if (this.terminated) return [];
    return this.emit([
      { type: 'stream_error', error },
      { type: 'message_end', stop_reason: 'error', usage: this.usage },
    ]);
  }

  protected abstract consume(event: unknown): IRStreamEvent[];
  protected abstract flushPending(): IRStreamEvent[];
}

// ---------------------------------------------------------------------------
// Anthropic SSE machine
// ---------------------------------------------------------------------------

class AnthropicMachine extends BaseMachine {
  /** input_json_delta partials keyed by content_block index. */
  private pending = new Map<number, PendingTool>();
  /** Raw wire components — Anthropic's input_tokens EXCLUDES cache tokens. */
  private rawIn = 0;
  private cacheRead = 0;
  private cacheCreation = 0;
  private sawCacheCreation = false;

  /**
   * Fold a wire `usage` object (message_start or message_delta) into the IR
   * usage. Same math as parseUsage in egress-anthropic.ts: IR `in` = TOTAL
   * input incl. cache reads/writes (ai-SDK/OpenAI semantics); cached_in /
   * cache_creation_in remain the discountable subsets.
   */
  private applyWireUsage(u: Rec): void {
    if (typeof u['input_tokens'] === 'number') this.rawIn = u['input_tokens'];
    if (typeof u['cache_read_input_tokens'] === 'number') this.cacheRead = u['cache_read_input_tokens'];
    if (typeof u['cache_creation_input_tokens'] === 'number') {
      this.cacheCreation = u['cache_creation_input_tokens'];
      this.sawCacheCreation = true;
    }
    if (typeof u['output_tokens'] === 'number') this.usage.out = u['output_tokens'];
    this.usage.in = this.rawIn + this.cacheRead + this.cacheCreation;
    this.usage.cached_in = this.cacheRead;
    if (this.sawCacheCreation) this.usage.cache_creation_in = this.cacheCreation;
  }

  protected flushPending(): IRStreamEvent[] {
    const out: IRStreamEvent[] = [];
    for (const t of this.pending.values()) out.push(finishTool(t));
    this.pending.clear();
    return out;
  }

  protected consume(event: unknown): IRStreamEvent[] {
    if (!isRec(event)) return [];
    const out: IRStreamEvent[] = [];

    switch (event['type']) {
      case 'message_start': {
        const msg = isRec(event['message']) ? event['message'] : {};
        if (isRec(msg['usage'])) this.applyWireUsage(msg['usage']);
        break;
      }
      case 'content_block_start': {
        const idx = typeof event['index'] === 'number' ? event['index'] : 0;
        const cb = isRec(event['content_block']) ? event['content_block'] : {};
        if (cb['type'] === 'tool_use') {
          const t: PendingTool = {
            id: typeof cb['id'] === 'string' ? cb['id'] : '',
            name: typeof cb['name'] === 'string' ? cb['name'] : '',
            json: '',
          };
          this.pending.set(idx, t);
          out.push({ type: 'tool_use_start', id: t.id, name: t.name });
        }
        break;
      }
      case 'content_block_delta': {
        const idx = typeof event['index'] === 'number' ? event['index'] : 0;
        const d = isRec(event['delta']) ? event['delta'] : {};
        if (d['type'] === 'text_delta' && typeof d['text'] === 'string') {
          out.push({ type: 'text_delta', text: d['text'] });
        } else if (d['type'] === 'input_json_delta' && typeof d['partial_json'] === 'string') {
          const t = this.pending.get(idx);
          if (t !== undefined) {
            t.json += d['partial_json'];
            out.push({ type: 'tool_input_delta', id: t.id, partial_json: d['partial_json'] });
          }
        }
        break;
      }
      case 'content_block_stop': {
        const idx = typeof event['index'] === 'number' ? event['index'] : 0;
        const t = this.pending.get(idx);
        if (t !== undefined) {
          this.pending.delete(idx);
          out.push(finishTool(t));
        }
        break;
      }
      case 'message_delta': {
        const d = isRec(event['delta']) ? event['delta'] : {};
        if (d['stop_reason'] !== undefined && d['stop_reason'] !== null) {
          this.stopReason = anthropicStopReasonToIR(d['stop_reason']);
        }
        if (isRec(event['usage'])) this.applyWireUsage(event['usage']);
        break;
      }
      case 'message_stop': {
        out.push(...this.flushPending());
        out.push({ type: 'message_end', stop_reason: this.stopReason, usage: this.usage });
        break;
      }
      case 'error': {
        const e = isRec(event['error']) ? event['error'] : {};
        const msg = typeof e['message'] === 'string' ? e['message'] : 'anthropic stream error';
        out.push({ type: 'stream_error', error: msg });
        out.push({ type: 'message_end', stop_reason: 'error', usage: this.usage });
        break;
      }
      default:
        // ping / unknown event types are ignored.
        break;
    }
    return out;
  }
}

/** Typed-event state machine for Anthropic Messages SSE objects. Single-use. */
export function parseAnthropicSSE(): IRStreamMachine {
  return new AnthropicMachine();
}

// ---------------------------------------------------------------------------
// OpenAI SSE machine
// ---------------------------------------------------------------------------

class OpenAIMachine extends BaseMachine {
  /** tool_call accumulation keyed by delta.tool_calls[].index. */
  private pending = new Map<number, PendingTool>();
  private sawFinish = false;

  protected flushPending(): IRStreamEvent[] {
    const out: IRStreamEvent[] = [];
    for (const [, t] of [...this.pending.entries()].sort(([a], [b]) => a - b)) {
      out.push(finishTool(t));
    }
    this.pending.clear();
    return out;
  }

  protected consume(event: unknown): IRStreamEvent[] {
    if (!isRec(event)) return [];
    const out: IRStreamEvent[] = [];

    // usage may arrive on any chunk (stream_options.include_usage sends a
    // final choices-empty chunk carrying it).
    if (isRec(event['usage'])) {
      const u = event['usage'];
      const details = isRec(u['prompt_tokens_details']) ? u['prompt_tokens_details'] : {};
      this.usage = {
        in: typeof u['prompt_tokens'] === 'number' ? u['prompt_tokens'] : this.usage.in,
        out: typeof u['completion_tokens'] === 'number' ? u['completion_tokens'] : this.usage.out,
        cached_in: typeof details['cached_tokens'] === 'number' ? details['cached_tokens'] : this.usage.cached_in,
      };
      // If finish already seen, this trailing usage chunk completes the message.
      if (this.sawFinish) {
        out.push(...this.flushPending());
        out.push({ type: 'message_end', stop_reason: this.stopReason, usage: this.usage });
        return out;
      }
    }

    const choices = Array.isArray(event['choices']) ? event['choices'] : [];
    const choice = isRec(choices[0]) ? choices[0] : undefined;
    if (choice === undefined) return out;

    const delta = isRec(choice['delta']) ? choice['delta'] : {};

    if (typeof delta['content'] === 'string' && delta['content'] !== '') {
      out.push({ type: 'text_delta', text: delta['content'] });
    }

    const toolCalls = Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : [];
    for (const tc of toolCalls) {
      if (!isRec(tc)) continue;
      const idx = typeof tc['index'] === 'number' ? tc['index'] : 0;
      const fn = isRec(tc['function']) ? tc['function'] : {};
      let t = this.pending.get(idx);
      if (t === undefined) {
        t = {
          id: typeof tc['id'] === 'string' ? tc['id'] : `call_${idx}`,
          name: typeof fn['name'] === 'string' ? fn['name'] : '',
          json: '',
        };
        this.pending.set(idx, t);
        out.push({ type: 'tool_use_start', id: t.id, name: t.name });
      } else {
        if (typeof tc['id'] === 'string' && tc['id'] !== '') t.id = tc['id'];
        if (typeof fn['name'] === 'string' && fn['name'] !== '') t.name = fn['name'];
      }
      if (typeof fn['arguments'] === 'string' && fn['arguments'] !== '') {
        t.json += fn['arguments'];
        out.push({ type: 'tool_input_delta', id: t.id, partial_json: fn['arguments'] });
      }
    }

    const finish = choice['finish_reason'];
    if (typeof finish === 'string' && finish !== '') {
      this.sawFinish = true;
      this.stopReason = openAIFinishReasonToIR(finish);
      out.push(...this.flushPending());
      // message_end is emitted at end() (transport's [DONE]) or on a trailing
      // usage chunk — whichever comes first — so include_usage totals land in it.
    }
    return out;
  }
}

/** Typed-event state machine for OpenAI Chat Completions chunks. Single-use. */
export function parseOpenAISSE(): IRStreamMachine {
  return new OpenAIMachine();
}
