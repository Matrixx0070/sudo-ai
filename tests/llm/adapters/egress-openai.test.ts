/**
 * @file tests/llm/adapters/egress-openai.test.ts
 * @description Golden tests for IR → OpenAI-compat body + response parsing:
 * plain text, single/parallel tool calls (last-moment re-stringify),
 * tool_result → role:'tool' (incl. is_error prefix), images, response_schema,
 * malformed response args (repaired + unrecoverable), provider-bug detection,
 * and the OpenAI→IR→OpenAI round trip (tool schema fidelity).
 */

import { describe, it, expect } from 'vitest';
import {
  egressOpenAI,
  parseOpenAIResponse,
  openAIFinishReasonToIR,
  irStopReasonToOpenAI,
} from '../../../src/llm/adapters/egress-openai.js';
import { ingressOpenAI } from '../../../src/llm/adapters/ingress-openai.js';
import type { IRRequest } from '../../../shared-types/ir/v1.js';

function baseIR(overrides: Partial<IRRequest> = {}): IRRequest {
  return {
    alias: 'openai/gpt-4o',
    caller: 'test',
    purpose: 'golden',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    priority: 'user',
    trace_id: 't1',
    ...overrides,
  };
}

describe('egressOpenAI', () => {
  it('(a) plain text: system → messages[0], text blocks → string content', () => {
    const body = egressOpenAI(baseIR({ system: 'Be helpful.', max_tokens: 64, temperature: 0.2 }));
    expect(body).toEqual({
      model: 'openai/gpt-4o',
      messages: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Hi' },
      ],
      max_tokens: 64,
      temperature: 0.2,
    });
  });

  it('(b) single tool call: tool_use → tool_calls with re-stringified arguments', () => {
    const body = egressOpenAI(
      baseIR({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo' } }],
          },
        ],
      }),
    );
    expect(body['messages']).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } },
        ],
      },
    ]);
  });

  it('(c) parallel tool calls survive as multiple tool_calls entries', () => {
    const body = egressOpenAI(
      baseIR({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'on it' },
              { type: 'tool_use', id: 'a', name: 'f1', input: { x: 1 } },
              { type: 'tool_use', id: 'b', name: 'f2', input: { y: 2 } },
            ],
          },
        ],
      }),
    );
    const msgs = body['messages'] as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({
      role: 'assistant',
      content: 'on it',
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'f1', arguments: '{"x":1}' } },
        { id: 'b', type: 'function', function: { name: 'f2', arguments: '{"y":2}' } },
      ],
    });
  });

  it("(d) tool_result blocks → role:'tool' messages; is_error noted with prefix", () => {
    const body = egressOpenAI(
      baseIR({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'a', content: 'ok result' },
              { type: 'tool_result', tool_use_id: 'b', content: 'boom', is_error: true },
              { type: 'text', text: 'continue' },
            ],
          },
        ],
      }),
    );
    expect(body['messages']).toEqual([
      { role: 'tool', tool_call_id: 'a', content: 'ok result' },
      { role: 'tool', tool_call_id: 'b', content: '[tool error] boom' },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('images: base64 → data: URL content part; response_schema → response_format', () => {
    const body = egressOpenAI(
      baseIR({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
              { type: 'image', source: { type: 'url', url: 'https://x.test/i.png' } },
            ],
          },
        ],
        response_schema: { type: 'object', properties: { a: { type: 'number' } } },
      }),
    );
    const msgs = body['messages'] as Array<Record<string, unknown>>;
    expect(msgs[0]!['content']).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'https://x.test/i.png' } },
    ]);
    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'structured_output', strict: true, schema: { type: 'object', properties: { a: { type: 'number' } } } },
    });
  });

  it('round trip: OpenAI request → ingress → egress preserves tool schema byte-exact and args object-equal', () => {
    const parameters = {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name', enum: ['Oslo', 'Bergen', 'Tromsø'] },
        days: { type: 'integer', minimum: 1, maximum: 14 },
      },
      required: ['city', 'days'],
      additionalProperties: false,
    };
    const original = {
      model: 'openai/gpt-4o',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'weather' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo","days":3}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Look up weather', parameters } }],
    };
    const out = egressOpenAI(ingressOpenAI(original, { caller: 'c', purpose: 'p' }));

    // Tool schema fidelity — byte-exact JSON.
    expect(JSON.stringify(out['tools'])).toBe(JSON.stringify(original.tools));
    // Args survive at object level (key order not guaranteed byte-exact).
    const msgs = out['messages'] as Array<Record<string, unknown>>;
    const asst = msgs.find((m) => m['role'] === 'assistant')!;
    const call = (asst['tool_calls'] as Array<{ function: { arguments: string } }>)[0]!;
    expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Oslo', days: 3 });
    const toolMsg = msgs.find((m) => m['role'] === 'tool')!;
    expect(toolMsg).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'sunny' });
  });
});

describe('parseOpenAIResponse', () => {
  it('(a) plain text response with usage incl. cached tokens', () => {
    const res = parseOpenAIResponse(
      {
        choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
      },
      'tr1',
    );
    expect(res).toEqual({
      blocks: [{ type: 'text', text: 'Hello!' }],
      stop_reason: 'end_turn',
      usage: { in: 10, out: 5, cached_in: 4 },
      trace_id: 'tr1',
    });
  });

  it('(b/c) tool calls (parallel) → tool_use blocks with parsed inputs; finish_reason tool_calls', () => {
    const res = parseOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'a', type: 'function', function: { name: 'f1', arguments: '{"x":1}' } },
                { id: 'b', type: 'function', function: { name: 'f2', arguments: '{"y":2}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
      'tr2',
    );
    expect(res.stop_reason).toBe('tool_use');
    expect(res.blocks).toEqual([
      { type: 'tool_use', id: 'a', name: 'f1', input: { x: 1 } },
      { type: 'tool_use', id: 'b', name: 'f2', input: { y: 2 } },
    ]);
  });

  it('(e) malformed args: repaired vs unrecoverable → {} + extra.parse_error', () => {
    const res = parseOpenAIResponse(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'ok', function: { name: 'f', arguments: '{broken: yes,}' } }, // jsonrepair recovers
                { id: 'bad', function: { name: 'g', arguments: '42' } }, // non-object → unrecoverable
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      'tr3',
    );
    expect(res.blocks[0]).toEqual({ type: 'tool_use', id: 'ok', name: 'f', input: { broken: 'yes' } });
    expect(res.blocks[1]).toMatchObject({ type: 'tool_use', id: 'bad', input: {} });
    const pe = res.extra?.['parse_error'] as Record<string, string>;
    expect(Object.keys(pe)).toEqual(['bad']);
  });

  it('finish_reason map: length → max_tokens, content_filter → error + extra.reason', () => {
    const lengthRes = parseOpenAIResponse(
      { choices: [{ message: { content: 'trunc' }, finish_reason: 'length' }] },
      't',
    );
    expect(lengthRes.stop_reason).toBe('max_tokens');
    const cfRes = parseOpenAIResponse(
      { choices: [{ message: { content: 'partial' }, finish_reason: 'content_filter' }] },
      't',
    );
    expect(cfRes.stop_reason).toBe('error');
    expect(cfRes.extra?.['reason']).toBe('content_filter');
  });

  it('200-but-garbage: no choices / empty content + no tool calls → error + provider_bug', () => {
    for (const garbage of [
      {},
      { choices: [] },
      { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
      'not even an object',
    ]) {
      const res = parseOpenAIResponse(garbage, 'tg');
      expect(res.stop_reason).toBe('error');
      expect(res.extra?.['provider_bug']).toBe(true);
      expect(res.blocks).toEqual([]);
    }
  });

  it('stop-reason reverse map is total and inverts the forward map', () => {
    expect(irStopReasonToOpenAI('end_turn')).toBe('stop');
    expect(irStopReasonToOpenAI('max_tokens')).toBe('length');
    expect(irStopReasonToOpenAI('tool_use')).toBe('tool_calls');
    expect(irStopReasonToOpenAI('error')).toBe('content_filter');
    for (const wire of ['stop', 'length', 'tool_calls'] as const) {
      expect(irStopReasonToOpenAI(openAIFinishReasonToIR(wire))).toBe(wire);
    }
  });
});
