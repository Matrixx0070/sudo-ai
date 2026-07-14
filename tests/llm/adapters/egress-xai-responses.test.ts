/**
 * @file tests/llm/adapters/egress-xai-responses.test.ts
 * @description Unit tests for the xAI Responses adapter (xai-oauth Phase 2):
 * IR → Responses request egress (thinking history STRIPPED — gotcha 2),
 * response parsing (reasoning → thinking on the way OUT), and the SSE machine
 * (RULE 4 contract identical to the stream.ts machines).
 */

import { describe, expect, it } from 'vitest';
import type { IRRequest } from '../../../shared-types/ir/v1.js';
import {
  egressXaiResponses,
  parseXaiResponsesResponse,
  createXaiResponsesSSEMachine,
} from '../../../src/llm/adapters/egress-xai-responses.js';

const TRACE = 'trace-xai-resp-1';

function baseIR(partial: Partial<IRRequest> = {}): IRRequest {
  return {
    alias: 'xai-oauth/grok-4.3',
    caller: 'test',
    purpose: 'xai-responses-unit',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    priority: 'user',
    trace_id: TRACE,
    max_tokens: 128,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Request egress
// ---------------------------------------------------------------------------

describe('egressXaiResponses', () => {
  it('maps text + system into Responses input items with input_text/output_text parts', () => {
    const body = egressXaiResponses(
      baseIR({
        system: 'Be terse.',
        temperature: 0.4,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Q' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'A' }] },
          { role: 'user', content: [{ type: 'text', text: 'more' }] },
        ],
      }),
    );
    expect(body['model']).toBe('xai-oauth/grok-4.3'); // transport strips the prefix
    expect(body['max_output_tokens']).toBe(128);
    expect(body['temperature']).toBe(0.4);
    expect(body['input']).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: 'Be terse.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Q' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'A' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'more' }] },
    ]);
  });

  it('tool round-trip: tool_use → function_call items, tool_result → function_call_output', () => {
    const body = egressXaiResponses(
      baseIR({
        tools: [
          {
            name: 'get_weather',
            description: 'Look up weather.',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Weather in Oslo?' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Checking.' },
              { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: '4°C', is_error: false },
              { type: 'text', text: 'thanks' },
            ],
          },
        ],
      }),
    );
    // FLAT Responses tools — no Chat-Completions `function` wrapper.
    expect(body['tools']).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Look up weather.',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
    expect(body['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Weather in Oslo?' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
      // arguments re-stringified at the last moment.
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Oslo"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '4°C' },
      { role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
    ]);
  });

  it('is_error tool_result gets the [tool error] prefix (openai-egress parity)', () => {
    const body = egressXaiResponses(
      baseIR({
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true }],
          },
        ],
      }),
    );
    expect(body['input']).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: '[tool error] boom' },
    ]);
  });

  it('STRIPS thinking blocks from replayed history (gotcha 2: encrypted reasoning → 400)', () => {
    const body = egressXaiResponses(
      baseIR({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Q' }] },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'private chain', signature: 'sig-1' },
              { type: 'text', text: 'A' },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'go on' }] },
        ],
      }),
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('private chain');
    expect(serialized).not.toContain('reasoning');
    expect(body['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Q' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'A' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'go on' }] },
    ]);
  });

  it('response_schema → text.format json_schema', () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
    const body = egressXaiResponses(baseIR({ response_schema: schema }));
    expect(body['text']).toEqual({
      format: { type: 'json_schema', name: 'structured_output', strict: true, schema },
    });
  });

  it('image blocks become input_image parts (base64 → data URL)', () => {
    const body = egressXaiResponses(
      baseIR({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGk=' } },
            ],
          },
        ],
      }),
    );
    expect(body['input']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,aGk=' },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

describe('parseXaiResponsesResponse', () => {
  it('message/output_text → text blocks; usage incl. cached tokens', () => {
    const res = parseXaiResponsesResponse(
      {
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ready' }] },
        ],
        usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } },
      },
      TRACE,
    );
    expect(res.blocks).toEqual([{ type: 'text', text: 'ready' }]);
    expect(res.stop_reason).toBe('end_turn');
    expect(res.usage).toEqual({ in: 12, out: 4, cached_in: 3 });
    expect(res.trace_id).toBe(TRACE);
  });

  it('function_call → tool_use with OBJECT input (parse-once funnel), stop_reason tool_use', () => {
    const res = parseXaiResponsesResponse(
      {
        status: 'completed',
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Oslo"}' },
        ],
        usage: { input_tokens: 30, output_tokens: 18 },
      },
      TRACE,
    );
    expect(res.stop_reason).toBe('tool_use');
    expect(res.blocks).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
    ]);
  });

  it('malformed arguments are repaired; unrecoverable → {} + extra.parse_error', () => {
    const repaired = parseXaiResponsesResponse(
      { status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'f', arguments: "{'a': 1,}" }] },
      TRACE,
    );
    expect(repaired.blocks[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } });

    const broken = parseXaiResponsesResponse(
      { status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'f', arguments: '"bare"' }] },
      TRACE,
    );
    expect(broken.blocks[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'f', input: {} });
    expect(broken.extra?.['parse_error']).toBeDefined();
  });

  it('reasoning items map INTO IR thinking blocks (out only — stripped on replay)', () => {
    const res = parseXaiResponsesResponse(
      {
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought about it' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
        ],
        usage: { input_tokens: 5, output_tokens: 5 },
      },
      TRACE,
    );
    expect(res.blocks).toEqual([
      { type: 'thinking', thinking: 'thought about it' },
      { type: 'text', text: 'answer' },
    ]);
    expect(res.stop_reason).toBe('end_turn');
  });

  it('incomplete + max_output_tokens → stop_reason max_tokens', () => {
    const res = parseXaiResponsesResponse(
      {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'truncat' }] }],
        usage: { input_tokens: 5, output_tokens: 128 },
      },
      TRACE,
    );
    expect(res.stop_reason).toBe('max_tokens');
    expect(res.blocks).toEqual([{ type: 'text', text: 'truncat' }]);
  });

  it('failed → stop_reason error + extra.reason from the error object', () => {
    const res = parseXaiResponsesResponse(
      { status: 'failed', error: { code: 'server_error', message: 'exploded' }, output: [] },
      TRACE,
    );
    expect(res.stop_reason).toBe('error');
    expect(res.extra?.['reason']).toBe('exploded');
  });

  it('200-but-empty (no text, no calls) → error + extra.provider_bug', () => {
    for (const wire of [{ status: 'completed', output: [] }, { id: 'resp_x' }, null]) {
      const res = parseXaiResponsesResponse(wire, TRACE);
      expect(res.stop_reason).toBe('error');
      expect(res.extra?.['provider_bug']).toBe(true);
    }
  });

  it('reasoning-only output still counts as empty (provider_bug)', () => {
    const res = parseXaiResponsesResponse(
      { status: 'completed', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hm' }] }] },
      TRACE,
    );
    expect(res.stop_reason).toBe('error');
    expect(res.extra?.['provider_bug']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSE machine
// ---------------------------------------------------------------------------

const HAPPY_SCRIPT: unknown[] = [
  { type: 'response.created', response: {} },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
  { type: 'response.output_text.delta', output_index: 0, delta: 'Let me ' },
  { type: 'response.output_text.delta', output_index: 0, delta: 'check.' },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"city":' },
  { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"Oslo"}' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Oslo"}' } },
  {
    type: 'response.completed',
    response: { status: 'completed', usage: { input_tokens: 25, output_tokens: 17, input_tokens_details: { cached_tokens: 10 } } },
  },
];

describe('createXaiResponsesSSEMachine', () => {
  it('happy path: text deltas, tool start/deltas/end, in-band terminal with usage', () => {
    const m = createXaiResponsesSSEMachine();
    const events = HAPPY_SCRIPT.flatMap((ev) => m.push(ev));
    expect(events).toEqual([
      { type: 'text_delta', text: 'Let me ' },
      { type: 'text_delta', text: 'check.' },
      { type: 'tool_use_start', id: 'call_1', name: 'get_weather' },
      { type: 'tool_input_delta', id: 'call_1', partial_json: '{"city":' },
      { type: 'tool_input_delta', id: 'call_1', partial_json: '"Oslo"}' },
      { type: 'tool_use_end', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
      { type: 'message_end', stop_reason: 'tool_use', usage: { in: 25, out: 17, cached_in: 10 } },
    ]);
    expect(m.terminated).toBe(true);
    expect(m.firstTokenEmitted).toBe(true);
  });

  it('truncation: end() flushes pending tool args and emits the terminal', () => {
    const m = createXaiResponsesSSEMachine();
    const events = HAPPY_SCRIPT.slice(0, 7).flatMap((ev) => m.push(ev)); // cut before item.done
    expect(events.at(-1)).toEqual({ type: 'tool_input_delta', id: 'call_1', partial_json: '"Oslo"}' });
    const flushed = m.end();
    expect(flushed).toEqual([
      { type: 'tool_use_end', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } },
      { type: 'message_end', stop_reason: 'end_turn', usage: { in: 0, out: 0, cached_in: 0 } },
    ]);
    expect(m.terminated).toBe(true);
    expect(m.end()).toEqual([]); // idempotent after terminal
  });

  it('fail(): stream_error + terminal error; single-use enforced after terminal', () => {
    const m = createXaiResponsesSSEMachine();
    m.push({ type: 'response.output_text.delta', delta: 'partial an' });
    expect(m.firstTokenEmitted).toBe(true);
    expect(m.fail('upstream socket reset')).toEqual([
      { type: 'stream_error', error: 'upstream socket reset' },
      { type: 'message_end', stop_reason: 'error', usage: { in: 0, out: 0, cached_in: 0 } },
    ]);
    expect(m.terminated).toBe(true);
    expect(() => m.push({ type: 'response.output_text.delta', delta: 'x' })).toThrow(/single-use/);
    expect(m.fail('again')).toEqual([]); // no-op after terminal
  });

  it('response.failed emits stream_error + terminal error', () => {
    const m = createXaiResponsesSSEMachine();
    const events = m.push({
      type: 'response.failed',
      response: { status: 'failed', error: { message: 'model exploded' }, usage: { input_tokens: 3, output_tokens: 0 } },
    });
    expect(events).toEqual([
      { type: 'stream_error', error: 'model exploded' },
      { type: 'message_end', stop_reason: 'error', usage: { in: 3, out: 0, cached_in: 0 } },
    ]);
  });

  it('incomplete terminal with max_output_tokens → stop_reason max_tokens', () => {
    const m = createXaiResponsesSSEMachine();
    m.push({ type: 'response.output_text.delta', delta: 'trunc' });
    const events = m.push({
      type: 'response.incomplete',
      response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 128 } },
    });
    expect(events).toEqual([
      { type: 'message_end', stop_reason: 'max_tokens', usage: { in: 5, out: 128, cached_in: 0 } },
    ]);
  });
});
