/**
 * @file transport-stream.ts
 * @description SSE streaming internals for the IR transport (split out of
 * transport.ts to keep that file under the max-lines ratchet). Pure leaf
 * helpers consumed by `streamIR`: an incremental SSE frame parser, the
 * claude-oauth tool-name reverse map for yielded events, a response
 * accumulator that rebuilds an IRResponse from the event stream for llm_calls
 * observability parity, and the per-chunk feed that drives the stream machine.
 *
 * These carry no transport policy/auth/route logic — that stays in transport.ts.
 */

import type { IRResponse, IRUsage } from '../../shared-types/ir/v1.js';
import type { IRStreamEvent, IRStreamMachine } from './adapters/stream.js';
import type { Family } from './transport.js';

/**
 * Incremental SSE frame parser: bytes → `data:` payload strings.
 * - Frames are separated by a blank line; \r\n, \n and \r line ends accepted.
 * - Comment lines (`: keepalive`) and non-data fields (`event:`, `id:`,
 *   `retry:`) are ignored — Anthropic repeats the event type inside the data
 *   JSON, so the `event:` field carries no extra information.
 * - Multiple `data:` lines in one frame are joined with '\n' (SSE spec).
 * - A trailing '\r' at the end of a chunk is held back until the next chunk
 *   so a \r\n split across chunk boundaries never yields a phantom line.
 */
export function createSSEParser(): { feed(chunk: Uint8Array): string[] } {
  const decoder = new TextDecoder();
  let buf = '';
  let dataLines: string[] = [];

  function handleLine(line: string, out: string[]): void {
    if (line === '') {
      // Blank line = end of frame; dispatch accumulated data (if any).
      if (dataLines.length > 0) {
        out.push(dataLines.join('\n'));
        dataLines = [];
      }
      return;
    }
    if (line.startsWith(':')) return; // comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return; // event:/id:/retry: ignored
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }

  return {
    feed(chunk: Uint8Array): string[] {
      buf += decoder.decode(chunk, { stream: true });
      const out: string[] = [];
      let start = 0;
      while (start < buf.length) {
        const nl = buf.indexOf('\n', start);
        const cr = buf.indexOf('\r', start);
        let end: number;
        let next: number;
        if (cr !== -1 && (nl === -1 || cr < nl)) {
          if (cr === buf.length - 1) break; // might be half of a \r\n — wait
          end = cr;
          next = buf[cr + 1] === '\n' ? cr + 2 : cr + 1;
        } else if (nl !== -1) {
          end = nl;
          next = nl + 1;
        } else {
          break; // no complete line yet
        }
        handleLine(buf.slice(start, end), out);
        start = next;
      }
      buf = buf.slice(start);
      return out;
    },
  };
}

/** claude-oauth reverse map applied to yielded tool events (mirrors callIR). */
export function reverseEventToolName(ev: IRStreamEvent, nameMap: Map<string, string>): IRStreamEvent {
  if (nameMap.size === 0) return ev;
  if ((ev.type === 'tool_use_start' || ev.type === 'tool_use_end') && nameMap.has(ev.name)) {
    return { ...ev, name: nameMap.get(ev.name)! };
  }
  return ev;
}

/**
 * Rebuild an IRResponse from the yielded event stream so the llm_calls row
 * stores the same full ir_response callIR would have (observability parity).
 */
export function createResponseAccumulator(traceId: string): {
  add(ev: IRStreamEvent): void;
  terminal: { stop_reason: IRResponse['stop_reason']; usage: IRUsage } | null;
  toIRResponse(partialUsage?: IRUsage): IRResponse;
} {
  const blocks: IRResponse['blocks'] = [];
  const acc = {
    terminal: null as { stop_reason: IRResponse['stop_reason']; usage: IRUsage } | null,
    add(ev: IRStreamEvent): void {
      if (ev.type === 'text_delta') {
        const last = blocks[blocks.length - 1];
        if (last !== undefined && last.type === 'text') last.text += ev.text;
        else blocks.push({ type: 'text', text: ev.text });
      } else if (ev.type === 'tool_use_end') {
        blocks.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
      } else if (ev.type === 'message_end') {
        acc.terminal = { stop_reason: ev.stop_reason, usage: ev.usage };
      }
    },
    toIRResponse(partialUsage?: IRUsage): IRResponse {
      return {
        blocks,
        // Consumer abandoned the stream before the terminal event →
        // stop_reason 'error' on the partial (mirror brain's partial-usage
        // billing philosophy: record what is known, never invent success) —
        // with the machine's last-known usage snapshot, not zeros.
        stop_reason: acc.terminal?.stop_reason ?? 'error',
        usage: acc.terminal?.usage ?? partialUsage ?? { in: 0, out: 0, cached_in: 0 },
        trace_id: traceId,
      };
    },
  };
  return acc;
}

/** Live state handed from the policy-wrapped attempt to the yield loop. */
export interface LiveStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  machine: IRStreamMachine;
  parser: ReturnType<typeof createSSEParser>;
  /** Events emitted during the attempt (first batch, possibly terminal). */
  buffered: IRStreamEvent[];
  /** Reader exhausted during the attempt. */
  readerDone: boolean;
  /** In-band terminal seen ([DONE] / anthropic message_stop / error event). */
  cleanTerminal: boolean;
  /** The terminal message_end came from a truncation flush (RULE 4 audit). */
  truncated: boolean;
}

/** Feed one byte chunk through parser+machine. Mutates `live` bookkeeping. */
export function feedChunk(live: LiveStream, chunk: Uint8Array, family: Family): IRStreamEvent[] {
  const out: IRStreamEvent[] = [];
  for (const payload of live.parser.feed(chunk)) {
    if (live.machine.terminated) break; // single-use: never push past terminal
    if (family !== 'anthropic' && payload.trim() === '[DONE]') {
      // xai-responses: response.completed is the in-band terminal — a
      // trailing [DONE] (if the endpoint sends one) makes end() a no-op.
      // OpenAI trailing-usage contract: the transport calls machine.end() at
      // [DONE]; a trailing usage chunk after finish_reason has already
      // emitted the terminal message_end, in which case end() is a no-op.
      live.cleanTerminal = true;
      out.push(...live.machine.end());
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      continue; // non-JSON data payload — ignore (defensive)
    }
    out.push(...live.machine.push(json));
    if (live.machine.terminated) live.cleanTerminal = true; // in-band terminal
  }
  return out;
}
