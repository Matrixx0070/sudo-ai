/**
 * Prompt-emulated tool layer for the free grok.com app-chat lane.
 * Covers: system-prompt render, IR->transcript render (incl. tool_use/result),
 * and reply parsing across the instructed block, markdown-fence drift,
 * malformed blocks (fall through to text), and plain final answers.
 */

import { describe, it, expect } from 'vitest';
import type { IRMessage, IRTool } from '../../shared-types/ir/v1.js';
import {
  buildToolSystemPrompt,
  renderTranscript,
  buildChatMessage,
  parseGrokReply,
} from '../../src/llm/grok-web-tools.js';

const TOOLS: IRTool[] = [
  {
    name: 'get_weather',
    description: 'Current weather for a city',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
];

const seq = () => {
  let n = 0;
  return () => `id_${++n}`;
};

describe('buildToolSystemPrompt', () => {
  it('is empty with no tools', () => {
    expect(buildToolSystemPrompt([])).toBe('');
  });
  it('lists each tool with its schema and the call contract', () => {
    const p = buildToolSystemPrompt(TOOLS);
    expect(p).toContain('get_weather');
    expect(p).toContain('Current weather for a city');
    expect(p).toContain('"required":["city"]');
    expect(p).toContain('<tool_call>');
    expect(p).toContain('</tool_call>');
  });
});

describe('renderTranscript', () => {
  it('renders a multi-block conversation including tool_use and tool_result', () => {
    const messages: IRMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'weather in Paris?' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'x', name: 'get_weather', input: { city: 'Paris' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: '18C sunny' }],
      },
    ];
    const t = renderTranscript(messages);
    expect(t).toContain('User: weather in Paris?');
    expect(t).toContain('"name":"get_weather"');
    expect(t).toContain('Tool result: 18C sunny');
  });

  it('marks error tool results and drops thinking blocks', () => {
    const messages: IRMessage[] = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'y', content: 'boom', is_error: true }],
      },
    ];
    const t = renderTranscript(messages);
    expect(t).not.toContain('secret');
    expect(t).toContain('Tool error: boom');
  });
});

describe('buildChatMessage', () => {
  it('prepends the tool system prompt ahead of the transcript', () => {
    const msg = buildChatMessage(
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      TOOLS,
    );
    expect(msg.indexOf('get_weather')).toBeLessThan(msg.indexOf('User: hi'));
  });
  it('is just the transcript when there are no tools', () => {
    const msg = buildChatMessage([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], []);
    expect(msg).toBe('User: hi');
  });
});

describe('parseGrokReply', () => {
  it('parses the instructed <tool_call> block into a tool_use', () => {
    const r = parseGrokReply(
      'sure\n<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>',
      seq(),
    );
    expect(r).toEqual({ kind: 'tool_use', id: 'id_1', name: 'get_weather', input: { city: 'Paris' } });
  });

  it('handles nested-object arguments (balanced-brace extraction)', () => {
    const r = parseGrokReply(
      '<tool_call>{"name":"f","arguments":{"a":{"b":1},"c":"}"}}</tool_call>',
      seq(),
    );
    expect(r).toMatchObject({ kind: 'tool_use', name: 'f', input: { a: { b: 1 }, c: '}' } });
  });

  it('accepts a markdown ```json fence drift with input key', () => {
    const r = parseGrokReply('```json\n{"name":"g","input":{"x":2}}\n```', seq());
    expect(r).toMatchObject({ kind: 'tool_use', name: 'g', input: { x: 2 } });
  });

  it('treats a malformed tool block as final text (no silent failure)', () => {
    const r = parseGrokReply('<tool_call>\nnot json\n</tool_call>', seq());
    expect(r).toEqual({ kind: 'text', text: '<tool_call>\nnot json\n</tool_call>' });
  });

  it('treats a block with no name as text', () => {
    const r = parseGrokReply('<tool_call>{"arguments":{"x":1}}</tool_call>', seq());
    expect(r.kind).toBe('text');
  });

  it('returns a plain answer as trimmed text', () => {
    const r = parseGrokReply('  The weather is sunny.  ', seq());
    expect(r).toEqual({ kind: 'text', text: 'The weather is sunny.' });
  });

  it('mints an id via the injected idFn', () => {
    const r = parseGrokReply('<tool_call>{"name":"f","arguments":{}}</tool_call>', () => 'FIXED');
    expect(r).toMatchObject({ kind: 'tool_use', id: 'FIXED', input: {} });
  });
});
