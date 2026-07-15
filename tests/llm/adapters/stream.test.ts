/**
 * @file tests/llm/adapters/stream.test.ts
 * @description Golden tests for the SSE → IRStreamEvent state machines:
 * Anthropic + OpenAI happy paths (scripted event sequences, accumulated tool
 * input, final usage), malformed accumulated JSON (jsonrepair + parse_error),
 * RULE 4 (firstTokenEmitted gate, fail() after first token, single-use throw).
 */

import { describe, it, expect } from 'vitest';
import { streamIR, parseAnthropicSSE, parseOpenAISSE, type IRStreamEvent } from '../../../src/llm/adapters/stream.js';

function pushAll(machine: ReturnType<typeof streamIR>, events: unknown[]): IRStreamEvent[] {
  const out: IRStreamEvent[] = [];
  for (const e of events) out.push(...machine.push(e));
  return out;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const ANTHROPIC_TOOL_SCRIPT: unknown[] = [
  { type: 'message_start', message: { usage: { input_tokens: 25, cache_read_input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Oslo","days"' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':3}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 17 } },
  { type: 'message_stop' },
];

describe('parseAnthropicSSE', () => {
  it('(f) happy path: text deltas + accumulated tool input + final usage', () => {
    const m = streamIR('anthropic');
    expect(m.firstTokenEmitted).toBe(false);
    const events = pushAll(m, ANTHROPIC_TOOL_SCRIPT);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Let me ' },
      { type: 'text_delta', text: 'check.' },
      { type: 'tool_use_start', id: 'tu_1', name: 'get_weather' },
      { type: 'tool_input_delta', id: 'tu_1', partial_json: '{"city":' },
      { type: 'tool_input_delta', id: 'tu_1', partial_json: '"Oslo","days"' },
      { type: 'tool_input_delta', id: 'tu_1', partial_json: ':3}' },
      { type: 'tool_use_end', id: 'tu_1', name: 'get_weather', input: { city: 'Oslo', days: 3 } },
      // usage.in = TOTAL input incl. cache reads (25 + 10) — IRUsage invariant.
      { type: 'message_end', stop_reason: 'tool_use', usage: { in: 35, out: 17, cached_in: 10 } },
    ]);
    expect(m.terminated).toBe(true);
  });

  it('(f2) message_start cache_creation_input_tokens: summed into in + cache_creation_in kept', () => {
    const m = streamIR('anthropic');
    m.push({ type: 'message_start', message: { usage: { input_tokens: 25, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 1 } } });
    const events = m.push({ type: 'message_stop' });
    expect(events).toEqual([
      { type: 'message_end', stop_reason: 'end_turn', usage: { in: 40, out: 1, cached_in: 10, cache_creation_in: 5 } },
    ]);
  });

  it('(f3) partialUsage exposes the last-known snapshot BEFORE any terminal (cancelled-stream billing)', () => {
    const m = streamIR('anthropic');
    expect(m.partialUsage).toEqual({ in: 0, out: 0, cached_in: 0 });
    m.push({ type: 'message_start', message: { usage: { input_tokens: 25, cache_read_input_tokens: 10, output_tokens: 1 } } });
    // message_start alone emits nothing, but the snapshot already knows the prompt cost.
    expect(m.firstTokenEmitted).toBe(false);
    expect(m.partialUsage).toEqual({ in: 35, out: 1, cached_in: 10 });
    m.push({ type: 'message_delta', delta: {}, usage: { output_tokens: 9 } });
    expect(m.partialUsage).toEqual({ in: 35, out: 9, cached_in: 10 });
    // Snapshot is a COPY — mutating it never poisons the machine.
    const snap = m.partialUsage;
    snap.in = 0;
    expect(m.partialUsage.in).toBe(35);
  });

  it('malformed accumulated tool JSON: jsonrepair fallback; truly broken → {} + parse_error', () => {
    const m = parseAnthropicSSE();
    const events = pushAll(m, [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'r', name: 'f' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city": "Oslo"' } }, // truncated
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ]);
    const end = events.find((e) => e.type === 'tool_use_end')!;
    expect(end).toMatchObject({ id: 'r', input: { city: 'Oslo' } }); // jsonrepair closed the brace
  });

  it('error event → stream_error then terminal message_end with stop_reason error', () => {
    const m = parseAnthropicSSE();
    m.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } });
    const events = m.push({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    expect(events).toEqual([
      { type: 'stream_error', error: 'Overloaded' },
      { type: 'message_end', stop_reason: 'error', usage: { in: 0, out: 0, cached_in: 0 } },
    ]);
    expect(m.terminated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

const OPENAI_TOOL_SCRIPT: unknown[] = [
  { choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] },
  { choices: [{ delta: { content: 'Sure, ' }, finish_reason: null }] },
  { choices: [{ delta: { content: 'checking.' }, finish_reason: null }] },
  {
    choices: [
      { delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null },
    ],
  },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Os' } }] }, finish_reason: null }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'lo","days":3}' } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 8 } } },
];

describe('parseOpenAISSE', () => {
  it('(f) happy path: content deltas + accumulated arguments + trailing usage chunk', () => {
    const m = streamIR('openai');
    const events = pushAll(m, OPENAI_TOOL_SCRIPT);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Sure, ' },
      { type: 'text_delta', text: 'checking.' },
      { type: 'tool_use_start', id: 'call_1', name: 'get_weather' },
      { type: 'tool_input_delta', id: 'call_1', partial_json: '{"city":"Os' },
      { type: 'tool_input_delta', id: 'call_1', partial_json: 'lo","days":3}' },
      { type: 'tool_use_end', id: 'call_1', name: 'get_weather', input: { city: 'Oslo', days: 3 } },
      { type: 'message_end', stop_reason: 'tool_use', usage: { in: 30, out: 12, cached_in: 8 } },
    ]);
    expect(m.terminated).toBe(true);
  });

  it('no trailing usage chunk: transport end() ([DONE]) emits message_end with captured state', () => {
    const m = parseOpenAISSE();
    pushAll(m, [
      { choices: [{ delta: { content: 'Hi' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    expect(m.terminated).toBe(false);
    const events = m.end();
    expect(events).toEqual([{ type: 'message_end', stop_reason: 'end_turn', usage: { in: 0, out: 0, cached_in: 0 } }]);
    expect(m.terminated).toBe(true);
    expect(m.end()).toEqual([]); // idempotent after terminal
  });

  it('same-chunk usage + finish_reason: message_end emitted IN-BAND, without [DONE]', () => {
    // Some OpenAI-compat providers batch finish_reason and usage into ONE
    // chunk. The terminal must not wait for a trailing usage chunk / [DONE]
    // that may never come before the socket idles.
    const m = parseOpenAISSE();
    const events = pushAll(m, [
      { choices: [{ delta: { content: 'Hi' }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } },
      },
    ]);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hi' },
      { type: 'message_end', stop_reason: 'end_turn', usage: { in: 9, out: 2, cached_in: 4 } },
    ]);
    expect(m.terminated).toBe(true);
    expect(m.end()).toEqual([]); // a trailing [DONE] stays a no-op
  });

  it('same-chunk usage + finish_reason flushes pending tools BEFORE the in-band terminal', () => {
    const m = parseOpenAISSE();
    const events = pushAll(m, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ]);
    expect(events).toEqual([
      { type: 'tool_use_start', id: 'c1', name: 'f' },
      { type: 'tool_input_delta', id: 'c1', partial_json: '{"a":1}' },
      { type: 'tool_use_end', id: 'c1', name: 'f', input: { a: 1 } },
      { type: 'message_end', stop_reason: 'tool_use', usage: { in: 5, out: 3, cached_in: 0 } },
    ]);
    expect(m.terminated).toBe(true);
  });

  it('parallel tool calls accumulate per index and flush in index order', () => {
    const m = parseOpenAISSE();
    const events = pushAll(m, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'f1', arguments: '{"x"' } },
                { index: 1, id: 'b', function: { name: 'f2', arguments: '{"y"' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: ':1}' } },
                { index: 1, function: { arguments: ':2}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const ends = events.filter((e) => e.type === 'tool_use_end');
    expect(ends).toEqual([
      { type: 'tool_use_end', id: 'a', name: 'f1', input: { x: 1 } },
      { type: 'tool_use_end', id: 'b', name: 'f2', input: { y: 2 } },
    ]);
  });

  it('unrecoverable accumulated arguments → input {} + parse_error on tool_use_end', () => {
    const m = parseOpenAISSE();
    const events = pushAll(m, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad', function: { name: 'f', arguments: '"scalar"' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const end = events.find((e) => e.type === 'tool_use_end')!;
    expect(end).toMatchObject({ id: 'bad', input: {} });
    expect((end as { parse_error?: string }).parse_error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// RULE 4 — retry gate + single-use enforcement
// ---------------------------------------------------------------------------

describe('RULE 4', () => {
  it('firstTokenEmitted flips on first emitted event, not on non-emitting input', () => {
    const m = parseAnthropicSSE();
    m.push({ type: 'message_start', message: { usage: { input_tokens: 5 } } });
    m.push({ type: 'ping' });
    expect(m.firstTokenEmitted).toBe(false); // transport may still retry
    m.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } });
    expect(m.firstTokenEmitted).toBe(true); // retry window closed
  });

  it('fail() after first token emits stream_error + terminal error message_end; then no-op', () => {
    const openai = parseOpenAISSE();
    openai.push({ choices: [{ delta: { content: 'x' }, finish_reason: null }] });
    expect(openai.fail('socket reset')).toEqual([
      { type: 'stream_error', error: 'socket reset' },
      { type: 'message_end', stop_reason: 'error', usage: { in: 0, out: 0, cached_in: 0 } },
    ]);
    expect(openai.terminated).toBe(true);
    expect(openai.fail('again')).toEqual([]); // MUST NOT restart
  });

  it('machines are single-use: push() after terminal message_end throws', () => {
    const m = parseAnthropicSSE();
    m.push({ type: 'message_stop' });
    expect(m.terminated).toBe(true);
    expect(() => m.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } })).toThrow(
      /single-use/,
    );
  });
});
