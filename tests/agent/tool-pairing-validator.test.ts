/**
 * sanitizeToolPairing — ID-based tool_use/tool_result repair run after any
 * history truncation (sliding window + compaction tail).
 *
 * The positional trims (selectVerbatimTail / the LAYER-3 window) only skip a
 * LEADING role:'tool' orphan and assume results sit contiguously after their
 * assistant. This validator is the authoritative final pass: it repairs orphans
 * in BOTH directions by matching toolCallId to the declaring assistant's
 * toolCalls[].id, so a truncated array can never reach the provider unpaired
 * (Vercel AI SDK AI_MissingToolResultsError / Anthropic "tool_use ids ... without
 * tool_result").
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeToolPairing,
  TRUNCATED_TOOL_RESULT_PLACEHOLDER,
  type BrainMessage,
} from '../../src/core/agent/loop-helpers.js';

const asst = (id: string, name = 'read'): BrainMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name, arguments: {} }],
});
const result = (id: string, content = 'ok'): BrainMessage => ({
  role: 'tool',
  toolCallId: id,
  toolName: 'read',
  content,
});

describe('sanitizeToolPairing', () => {
  it('leaves a well-paired transcript unchanged', () => {
    const msgs: BrainMessage[] = [
      { role: 'user', content: 'hi' },
      asst('a1'),
      result('a1'),
      { role: 'assistant', content: 'done' },
    ];
    expect(sanitizeToolPairing(msgs)).toEqual(msgs);
  });

  it('drops a LEADING orphan tool result (declaring assistant evicted)', () => {
    const msgs: BrainMessage[] = [
      result('gone'), // its assistant was truncated away above the window
      { role: 'user', content: 'next' },
      asst('a1'),
      result('a1'),
    ];
    const out = sanitizeToolPairing(msgs);
    expect(out.find((m) => m.role === 'tool' && m.toolCallId === 'gone')).toBeUndefined();
    expect(out.find((m) => m.role === 'tool' && m.toolCallId === 'a1')).toBeDefined();
    expect(out).toHaveLength(3);
  });

  it('drops an INTERIOR orphan tool result the positional trim would miss', () => {
    const msgs: BrainMessage[] = [
      asst('a1'),
      result('a1'),
      result('orphan'), // no assistant ever declared this id
      { role: 'user', content: 'ok' },
    ];
    const out = sanitizeToolPairing(msgs);
    expect(out.some((m) => m.role === 'tool' && m.toolCallId === 'orphan')).toBe(false);
    expect(out).toHaveLength(3);
  });

  it('synthesizes a placeholder result for an assistant tool_call with no result', () => {
    const msgs: BrainMessage[] = [
      { role: 'user', content: 'go' },
      asst('a1'), // result truncated away — orphan tool_use
      { role: 'user', content: 'again' },
    ];
    const out = sanitizeToolPairing(msgs);
    const synth = out.find((m) => m.role === 'tool' && m.toolCallId === 'a1');
    expect(synth).toBeDefined();
    expect(synth!.content).toBe(TRUNCATED_TOOL_RESULT_PLACEHOLDER);
    // Placeholder sits immediately after its declaring assistant.
    expect(out.indexOf(synth!)).toBe(out.findIndex((m) => m.role === 'assistant') + 1);
  });

  it('handles parallel tool_calls where only some results survived', () => {
    const msgs: BrainMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'p1', name: 'read', arguments: {} },
          { id: 'p2', name: 'grep', arguments: {} },
        ],
      },
      result('p1'), // p2's result was truncated
    ];
    const out = sanitizeToolPairing(msgs);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(out.find((m) => m.toolCallId === 'p2')!.content).toBe(TRUNCATED_TOOL_RESULT_PLACEHOLDER);
    expect(out.find((m) => m.toolCallId === 'p1')!.content).toBe('ok');
  });

  it('does not synthesize when the real result appears later in the window', () => {
    const msgs: BrainMessage[] = [
      asst('a1'),
      { role: 'assistant', content: 'thinking' },
      result('a1'), // present, just not immediately adjacent
    ];
    const out = sanitizeToolPairing(msgs);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
    expect(out.find((m) => m.toolCallId === 'a1')!.content).toBe('ok');
  });

  it('is a no-op for a transcript with no tools', () => {
    const msgs: BrainMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(sanitizeToolPairing(msgs)).toEqual(msgs);
  });
});
