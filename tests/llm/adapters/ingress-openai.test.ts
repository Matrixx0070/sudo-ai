/**
 * @file tests/llm/adapters/ingress-openai.test.ts
 * @description Golden tests for OpenAI Chat Completions request → IR:
 * plain text, system/developer folding, tool calls (single + parallel),
 * role:"tool" folding into user tool_result messages, malformed arguments
 * (jsonrepair + unrecoverable), tools/response_format mapping, extras.
 */

import { describe, it, expect } from 'vitest';
import { ingressOpenAI } from '../../../src/llm/adapters/ingress-openai.js';
import { parseIRRequest } from '../../../shared-types/ir/v1.js';

const META = { caller: 'test', purpose: 'golden' };

describe('ingressOpenAI', () => {
  it('(a) plain text request: system → IRRequest.system, user/assistant → blocks', () => {
    const ir = ingressOpenAI(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'developer', content: 'Be terse.' },
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
        ],
        temperature: 0.5,
        max_tokens: 100,
      },
      { ...META, trace_id: 't1' },
    );
    expect(parseIRRequest(ir)).toEqual(ir); // schema-valid
    expect(ir.system).toBe('You are helpful.\n\nBe terse.');
    expect(ir.alias).toBe('gpt-4o');
    expect(ir.temperature).toBe(0.5);
    expect(ir.max_tokens).toBe(100);
    expect(ir.trace_id).toBe('t1');
    expect(ir.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
    ]);
  });

  it('(b) single tool call: arguments string parsed ONCE into a real object', () => {
    const ir = ingressOpenAI(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo","days":2}' } },
            ],
          },
        ],
      },
      META,
    );
    expect(ir.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Oslo', days: 2 } }],
    });
    expect(ir.extra?.['parse_error']).toBeUndefined();
  });

  it('(c) parallel tool calls become multiple tool_use blocks in one turn', () => {
    const ir = ingressOpenAI(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'both' },
          {
            role: 'assistant',
            content: 'Working on it',
            tool_calls: [
              { id: 'a', type: 'function', function: { name: 'f1', arguments: '{"x":1}' } },
              { id: 'b', type: 'function', function: { name: 'f2', arguments: '{"y":2}' } },
            ],
          },
        ],
      },
      META,
    );
    const asst = ir.messages[1]!;
    expect(asst.content).toEqual([
      { type: 'text', text: 'Working on it' },
      { type: 'tool_use', id: 'a', name: 'f1', input: { x: 1 } },
      { type: 'tool_use', id: 'b', name: 'f2', input: { y: 2 } },
    ]);
  });

  it('(d) consecutive role:"tool" messages fold into ONE user message of tool_results', () => {
    const ir = ingressOpenAI(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'a', type: 'function', function: { name: 'f1', arguments: '{}' } },
              { id: 'b', type: 'function', function: { name: 'f2', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'a', content: 'result A' },
          { role: 'tool', tool_call_id: 'b', content: 'result B' },
          { role: 'assistant', content: 'done' },
        ],
      },
      META,
    );
    expect(ir.messages).toHaveLength(4);
    expect(ir.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'result A' },
        { type: 'tool_result', tool_use_id: 'b', content: 'result B' },
      ],
    });
    expect(ir.messages[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });
  });

  it('(e) malformed arguments: jsonrepair recovers trailing-comma/single-quote JSON', () => {
    const ir = ingressOpenAI(
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              { id: 'r', type: 'function', function: { name: 'f', arguments: "{'city': 'Oslo', 'days': 2,}" } },
            ],
          },
        ],
      },
      META,
    );
    const block = ir.messages[0]!.content[0]!;
    expect(block).toEqual({ type: 'tool_use', id: 'r', name: 'f', input: { city: 'Oslo', days: 2 } });
    expect(ir.extra?.['parse_error']).toBeUndefined();
  });

  it('(e2) unrecoverable arguments → input {} + extra.parse_error keyed by call id, no throw', () => {
    const ir = ingressOpenAI(
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'assistant',
            tool_calls: [{ id: 'bad', type: 'function', function: { name: 'f', arguments: '"just a string"' } }],
          },
        ],
      },
      META,
    );
    const block = ir.messages[0]!.content[0]!;
    expect(block).toMatchObject({ type: 'tool_use', id: 'bad', input: {} });
    const pe = ir.extra?.['parse_error'] as Record<string, string>;
    expect(typeof pe['bad']).toBe('string');
  });

  it('tools[] and response_format json_schema map to IRTool / response_schema', () => {
    const schema = {
      type: 'object',
      properties: { city: { type: 'string', enum: ['Oslo', 'Bergen'] } },
      required: ['city'],
    };
    const ir = ingressOpenAI(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather lookup', parameters: schema } }],
        response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' } } },
      },
      META,
    );
    expect(ir.tools).toEqual([{ name: 'get_weather', description: 'Weather lookup', input_schema: schema }]);
    expect(ir.response_schema).toEqual({ type: 'object' });
  });

  it('unmapped vendor fields ride in extra; image_url parts become image blocks', () => {
    const ir = ingressOpenAI(
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this?' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
              { type: 'image_url', image_url: { url: 'https://x.test/i.png' } },
            ],
          },
        ],
        top_p: 0.9,
        frequency_penalty: 0.1,
        user: 'abc',
      },
      META,
    );
    expect(ir.extra).toEqual({ top_p: 0.9, frequency_penalty: 0.1, user: 'abc' });
    expect(ir.messages[0]!.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://x.test/i.png' } },
    ]);
  });

  it('meta defaults: priority user, generated trace_id, alias override wins over model', () => {
    const ir = ingressOpenAI(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] },
      { caller: 'c', purpose: 'p', alias: 'sudo/cheap' },
    );
    expect(ir.alias).toBe('sudo/cheap');
    expect(ir.priority).toBe('user');
    expect(ir.trace_id).toMatch(/^ing-/);
  });
});
