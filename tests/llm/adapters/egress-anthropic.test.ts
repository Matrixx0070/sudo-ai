/**
 * @file tests/llm/adapters/egress-anthropic.test.ts
 * @description Golden tests for IR → Anthropic Messages body + response
 * parsing: plain text, tool calls (1:1 blocks), tool_result incl. is_error,
 * images, max_tokens always set, temperature clamp, response_schema → forced
 * tool, system split with cache_control on the static prefix only, tools
 * cache_control on last entry, stop-reason maps, provider-bug detection.
 */

import { describe, it, expect } from 'vitest';
import {
  egressAnthropic,
  parseAnthropicResponse,
  anthropicStopReasonToIR,
  irStopReasonToAnthropic,
  STRUCTURED_OUTPUT_TOOL,
} from '../../../src/llm/adapters/egress-anthropic.js';
import { DYNAMIC_BOUNDARY_MARKER } from '../../../src/core/brain/prompt-cache-discipline.js';
import { getAliasLimits } from '../../../src/llm/limits.js';
import type { IRRequest } from '../../../shared-types/ir/v1.js';

function baseIR(overrides: Partial<IRRequest> = {}): IRRequest {
  return {
    alias: 'anthropic/claude-opus-4-8',
    caller: 'test',
    purpose: 'golden',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    priority: 'user',
    trace_id: 't1',
    ...overrides,
  };
}

describe('egressAnthropic', () => {
  it('(a) plain text: bare model id, messages 1:1, single uncached system block', () => {
    const body = egressAnthropic(baseIR({ system: 'Be helpful.', max_tokens: 64 }));
    expect(body['model']).toBe('claude-opus-4-8');
    expect(body['max_tokens']).toBe(64);
    expect(body['system']).toEqual([{ type: 'text', text: 'Be helpful.' }]);
    expect(body['messages']).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]);
  });

  it('max_tokens is ALWAYS set — falls back to getAliasLimits(alias).max_output', () => {
    const body = egressAnthropic(baseIR());
    expect(body['max_tokens']).toBe(getAliasLimits('anthropic/claude-opus-4-8').max_output);
    expect(typeof body['max_tokens']).toBe('number');
    expect(body['max_tokens']).toBeGreaterThan(0);
  });

  it('temperature is clamped to 0..1 (3 → 1, -0.5 → 0)', () => {
    expect(egressAnthropic(baseIR({ temperature: 3 }))['temperature']).toBe(1);
    expect(egressAnthropic(baseIR({ temperature: -0.5 }))['temperature']).toBe(0);
    expect(egressAnthropic(baseIR({ temperature: 0.7 }))['temperature']).toBe(0.7);
    expect(egressAnthropic(baseIR())['temperature']).toBeUndefined();
  });

  it('system split at DYNAMIC_BOUNDARY_MARKER: cache_control on static prefix ONLY', () => {
    const system = `STATIC PART\n${DYNAMIC_BOUNDARY_MARKER}\nCurrent time: now`;
    const body = egressAnthropic(baseIR({ system, max_tokens: 10 }));
    expect(body['system']).toEqual([
      { type: 'text', text: 'STATIC PART\n', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `${DYNAMIC_BOUNDARY_MARKER}\nCurrent time: now` },
    ]);
  });

  it('(b/c) tool_use blocks map 1:1 (input stays a real object, parallel preserved)', () => {
    const body = egressAnthropic(
      baseIR({
        max_tokens: 10,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'a', name: 'f1', input: { x: 1 } },
              { type: 'tool_use', id: 'b', name: 'f2', input: { y: 2 } },
            ],
          },
        ],
      }),
    );
    expect(body['messages']).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'f1', input: { x: 1 } },
          { type: 'tool_use', id: 'b', name: 'f2', input: { y: 2 } },
        ],
      },
    ]);
  });

  it('(d) tool_result maps 1:1 incl. is_error and array content; images map source shapes', () => {
    const body = egressAnthropic(
      baseIR({
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
              {
                type: 'tool_result',
                tool_use_id: 'b',
                content: [{ type: 'text', text: 'boom' }],
                is_error: true,
              },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
              { type: 'image', source: { type: 'url', url: 'https://x.test/i.png' } },
            ],
          },
        ],
      }),
    );
    const msgs = body['messages'] as Array<{ content: unknown[] }>;
    expect(msgs[0]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'boom' }], is_error: true },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://x.test/i.png' } },
    ]);
  });

  it('tools map to Anthropic shape with cache_control on the LAST tool only', () => {
    const body = egressAnthropic(
      baseIR({
        max_tokens: 10,
        tools: [
          { name: 't1', description: 'first', input_schema: { type: 'object' } },
          { name: 't2', input_schema: { type: 'object', required: ['q'] } },
        ],
      }),
    );
    expect(body['tools']).toEqual([
      { name: 't1', description: 'first', input_schema: { type: 'object' } },
      { name: 't2', input_schema: { type: 'object', required: ['q'] }, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('response_schema → forced synthetic tool + tool_choice', () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
    const body = egressAnthropic(baseIR({ max_tokens: 10, response_schema: schema }));
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: STRUCTURED_OUTPUT_TOOL, input_schema: schema });
    expect(body['tool_choice']).toEqual({ type: 'tool', name: STRUCTURED_OUTPUT_TOOL });
  });
});

describe('parseAnthropicResponse', () => {
  it('(a) plain text response: blocks 1:1, usage incl. cache_read_input_tokens', () => {
    const res = parseAnthropicResponse(
      {
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 },
      },
      'tr1',
    );
    expect(res).toEqual({
      blocks: [{ type: 'text', text: 'Hello!' }],
      stop_reason: 'end_turn',
      usage: { in: 10, out: 5, cached_in: 7 },
      trace_id: 'tr1',
    });
  });

  it('(b/c) tool_use blocks pass through with object input (parallel preserved)', () => {
    const res = parseAnthropicResponse(
      {
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool_use', id: 'a', name: 'f1', input: { x: 1 } },
          { type: 'tool_use', id: 'b', name: 'f2', input: { y: 2 } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      'tr2',
    );
    expect(res.stop_reason).toBe('tool_use');
    expect(res.blocks).toEqual([
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id: 'a', name: 'f1', input: { x: 1 } },
      { type: 'tool_use', id: 'b', name: 'f2', input: { y: 2 } },
    ]);
  });

  it('(e) defensive: stringified input parsed once, unrecoverable → {} + parse_error', () => {
    const res = parseAnthropicResponse(
      {
        content: [
          { type: 'tool_use', id: 'ok', name: 'f', input: '{"x":1,}' },
          { type: 'tool_use', id: 'bad', name: 'g', input: 'null' },
        ],
        stop_reason: 'tool_use',
      },
      'tr3',
    );
    expect(res.blocks[0]).toEqual({ type: 'tool_use', id: 'ok', name: 'f', input: { x: 1 } });
    expect(res.blocks[1]).toMatchObject({ type: 'tool_use', id: 'bad', input: {} });
    const pe = res.extra?.['parse_error'] as Record<string, string>;
    expect(Object.keys(pe)).toEqual(['bad']);
  });

  it('stop_reason map: max_tokens, stop_sequence → end_turn + extra, refusal → error', () => {
    const mt = parseAnthropicResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'max_tokens' }, 't');
    expect(mt.stop_reason).toBe('max_tokens');

    const ss = parseAnthropicResponse(
      { content: [{ type: 'text', text: 'x' }], stop_reason: 'stop_sequence', stop_sequence: '###' },
      't',
    );
    expect(ss.stop_reason).toBe('end_turn');
    expect(ss.extra?.['stop_sequence']).toBe('###');

    const rf = parseAnthropicResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'refusal' }, 't');
    expect(rf.stop_reason).toBe('error');
    expect(rf.extra?.['reason']).toBe('refusal');
  });

  it('200-but-empty content → error + provider_bug', () => {
    for (const garbage of [{}, { content: [] }, { content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' }]) {
      const res = parseAnthropicResponse(garbage, 'tg');
      expect(res.stop_reason).toBe('error');
      expect(res.extra?.['provider_bug']).toBe(true);
      expect(res.blocks).toEqual([]);
    }
  });

  it('thinking blocks are mapped into the IR (A15 — previously dropped); redacted_thinking still dropped', () => {
    const res = parseAnthropicResponse(
      {
        content: [
          { type: 'thinking', thinking: 'step by step…', signature: 'sig-abc' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'Answer.' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 9 },
      },
      't',
    );
    expect(res.blocks).toEqual([
      { type: 'thinking', thinking: 'step by step…', signature: 'sig-abc' },
      { type: 'text', text: 'Answer.' },
    ]);
    expect(res.stop_reason).toBe('end_turn');
    expect(res.extra?.['provider_bug']).toBeUndefined();
  });

  it('thinking blocks in request history egress back to the wire verbatim (signature preserved)', () => {
    const body = egressAnthropic(
      baseIR({
        max_tokens: 10,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Q' }] },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'chain', signature: 'sig-1' },
              { type: 'thinking', thinking: 'no-sig' },
              { type: 'text', text: 'A' },
            ],
          },
        ],
      }),
    );
    const msgs = body['messages'] as Array<{ content: unknown[] }>;
    expect(msgs[1]!.content).toEqual([
      { type: 'thinking', thinking: 'chain', signature: 'sig-1' },
      { type: 'thinking', thinking: 'no-sig' },
      { type: 'text', text: 'A' },
    ]);
  });

  it('reverse stop-reason map is total and inverts the forward map', () => {
    expect(irStopReasonToAnthropic('end_turn')).toBe('end_turn');
    expect(irStopReasonToAnthropic('tool_use')).toBe('tool_use');
    expect(irStopReasonToAnthropic('max_tokens')).toBe('max_tokens');
    expect(irStopReasonToAnthropic('error')).toBe('refusal');
    for (const wire of ['end_turn', 'tool_use', 'max_tokens'] as const) {
      expect(irStopReasonToAnthropic(anthropicStopReasonToIR(wire))).toBe(wire);
    }
  });
});
