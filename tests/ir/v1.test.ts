/**
 * @file tests/ir/v1.test.ts
 * @description Schema-validity + round-trip tests for the internal IR v1
 * (gw-refactor Phase 2, part A).
 */

import { describe, it, expect } from 'vitest';
import {
  IR_VERSION,
  parseIRRequest,
  parseIRResponse,
  safeParseIRRequest,
  safeParseIRResponse,
  type IRRequest,
  type IRResponse,
} from '../../shared-types/ir/v1.js';

function validRequest(): IRRequest {
  return {
    alias: 'sudo/mid',
    caller: 'agent-loop',
    purpose: 'unit test',
    system: 'You are a helpful assistant.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Berlin' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny, 22C' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
          },
        ],
      },
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Get current weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    priority: 'user',
    trace_id: 'trace-123',
    max_tokens: 1024,
    temperature: 0.2,
  };
}

function validResponse(): IRResponse {
  return {
    blocks: [{ type: 'text', text: 'sunny in Berlin' }],
    stop_reason: 'end_turn',
    usage: { in: 120, out: 15, cached_in: 0 },
    cost_usd: 0.00042,
    trace_id: 'trace-123',
  };
}

describe('IR v1 schemas', () => {
  it('exports IR_VERSION = 1', () => {
    expect(IR_VERSION).toBe(1);
  });

  it('parses a valid IRRequest', () => {
    const parsed = parseIRRequest(validRequest());
    expect(parsed.alias).toBe('sudo/mid');
    expect(parsed.messages).toHaveLength(3);
  });

  it('parses a valid IRResponse', () => {
    const parsed = parseIRResponse(validResponse());
    expect(parsed.stop_reason).toBe('end_turn');
    expect(parsed.usage).toEqual({ in: 120, out: 15, cached_in: 0 });
  });

  it('rejects an invalid message role', () => {
    const req = validRequest();
    (req.messages[0] as { role: string }).role = 'system';
    expect(() => parseIRRequest(req)).toThrow();
  });

  it('rejects tool_use input that is a string (must be a real object)', () => {
    const req = validRequest();
    const toolUse = req.messages[1]!.content[1] as { input: unknown };
    toolUse.input = '{"city":"Berlin"}';
    const result = safeParseIRRequest(req);
    expect(result.success).toBe(false);
  });

  it('enforces the stop_reason enum', () => {
    const res = validResponse();
    (res as { stop_reason: string }).stop_reason = 'length';
    expect(() => parseIRResponse(res)).toThrow();
  });

  it('accepts every legal stop_reason', () => {
    for (const sr of ['end_turn', 'tool_use', 'max_tokens', 'error'] as const) {
      const res = { ...validResponse(), stop_reason: sr };
      expect(parseIRResponse(res).stop_reason).toBe(sr);
    }
  });

  it('extra allows arbitrary vendor keys on request and response', () => {
    const req = { ...validRequest(), extra: { xai_search: true, anthropic: { beta: ['x'] } } };
    expect(parseIRRequest(req).extra).toEqual({ xai_search: true, anthropic: { beta: ['x'] } });
    const res = { ...validResponse(), extra: { provider: 'xai', raw_finish: 'stop' } };
    expect(parseIRResponse(res).extra?.['provider']).toBe('xai');
  });

  it('requires trace_id on the request', () => {
    const req = validRequest() as Partial<IRRequest>;
    delete req.trace_id;
    expect(safeParseIRRequest(req).success).toBe(false);
  });

  it('requires trace_id on the response', () => {
    const res = validResponse() as Partial<IRResponse>;
    delete res.trace_id;
    expect(safeParseIRResponse(res).success).toBe(false);
  });

  it('requires priority and enforces its enum', () => {
    const missing = validRequest() as Partial<IRRequest>;
    delete missing.priority;
    expect(safeParseIRRequest(missing).success).toBe(false);
    const bad = { ...validRequest(), priority: 'urgent' };
    expect(safeParseIRRequest(bad).success).toBe(false);
    const bg = { ...validRequest(), priority: 'background' as const };
    expect(parseIRRequest(bg).priority).toBe('background');
  });

  it('accepts tool_result content as an array of text/image blocks and is_error', () => {
    const req = validRequest();
    req.messages[2]!.content[0] = {
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: [
        { type: 'text', text: 'stdout here' },
        { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
      ],
      is_error: true,
    };
    const parsed = parseIRRequest(req);
    const tr = parsed.messages[2]!.content[0];
    expect(tr).toMatchObject({ type: 'tool_result', is_error: true });
  });

  it('accepts thinking blocks (gw-cutover Phase 0, additive) with optional signature', () => {
    const req = validRequest();
    req.messages[1]!.content.unshift({ type: 'thinking', thinking: 'chain of thought' });
    expect(() => parseIRRequest(req)).not.toThrow();

    const res = validResponse();
    res.blocks.unshift({ type: 'thinking', thinking: 'reasoning…', signature: 'sig-1' });
    const parsed = parseIRResponse(res);
    expect(parsed.blocks[0]).toEqual({ type: 'thinking', thinking: 'reasoning…', signature: 'sig-1' });
  });

  it('rejects a thinking block whose thinking field is not a string', () => {
    const res = validResponse();
    res.blocks.push({ type: 'thinking', thinking: 42 } as unknown as IRResponse['blocks'][number]);
    expect(safeParseIRResponse(res).success).toBe(false);
  });

  it('rejects unknown content-block types', () => {
    const req = validRequest();
    (req.messages[0]!.content as unknown[]).push({ type: 'video', url: 'x' });
    expect(safeParseIRRequest(req).success).toBe(false);
  });

  it('round-trips through JSON without loss (request)', () => {
    const req = validRequest();
    const parsed = parseIRRequest(JSON.parse(JSON.stringify(req)));
    expect(parsed).toEqual(req);
  });

  it('round-trips through JSON without loss (response)', () => {
    const res = { ...validResponse(), extra: { nested: { a: [1, 2, 3] } } };
    const parsed = parseIRResponse(JSON.parse(JSON.stringify(res)));
    expect(parsed).toEqual(res);
  });

  it('safe variants return success:true with data for valid input', () => {
    const r = safeParseIRRequest(validRequest());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.caller).toBe('agent-loop');
  });
});
