/**
 * @file tests/brain/strip-empty-text-blocks.test.ts
 * @description Covers stripEmptyTextBlocks (B8.2) — the wire-level sanitiser
 * for the live claude-oauth 400 "messages: text content blocks must be
 * non-empty". Asserts: empty/whitespace-only text blocks are removed; real
 * text, tool_use, and tool_result blocks are preserved; string-content and
 * non-array messages are untouched; and the count returned is accurate.
 */

import { describe, it, expect } from 'vitest';
import { stripEmptyTextBlocks } from '../../src/core/brain/providers.js';

describe('stripEmptyTextBlocks', () => {
  it('removes an empty text block but keeps the real one', () => {
    const msgs = [
      { role: 'user', content: [
        { type: 'text', text: '' },
        { type: 'text', text: 'hello' },
      ] },
    ];
    const removed = stripEmptyTextBlocks(msgs);
    expect(removed).toBe(1);
    expect(msgs[0]!.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('removes whitespace-only text blocks', () => {
    const msgs = [
      { role: 'assistant', content: [
        { type: 'text', text: '   \n\t ' },
        { type: 'text', text: 'kept' },
      ] },
    ];
    expect(stripEmptyTextBlocks(msgs)).toBe(1);
    expect(msgs[0]!.content).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('preserves tool_use and tool_result blocks even when text alongside is empty', () => {
    const msgs = [
      { role: 'assistant', content: [
        { type: 'text', text: '' },
        { type: 'tool_use', id: 'tu_1', name: 'x', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
      ] },
    ];
    const removed = stripEmptyTextBlocks(msgs);
    expect(removed).toBe(1);
    expect(msgs[0]!.content).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'x', input: {} }]);
    expect(msgs[1]!.content).toHaveLength(1); // tool_result untouched
  });

  it('can empty a message whose only block was an empty text block (caller drops it)', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
    ];
    expect(stripEmptyTextBlocks(msgs)).toBe(1);
    expect(msgs[0]!.content).toEqual([]); // now empty — caller is responsible for dropping
  });

  it('is a no-op when no empty text blocks are present', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'real content' }] },
    ];
    const snapshot = JSON.parse(JSON.stringify(msgs));
    expect(stripEmptyTextBlocks(msgs)).toBe(0);
    expect(msgs).toEqual(snapshot);
  });

  it('leaves string-content and non-array-content messages untouched', () => {
    const msgs = [
      { role: 'user', content: 'plain string' },
      { role: 'system', content: '' },
      { role: 'user', content: [{ type: 'text', text: 'ok' }] },
    ];
    expect(stripEmptyTextBlocks(msgs as Array<Record<string, unknown>>)).toBe(0);
    expect(msgs[0]!.content).toBe('plain string');
    expect(msgs[1]!.content).toBe('');
  });

  it('counts across multiple messages', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: ' ' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ];
    expect(stripEmptyTextBlocks(msgs)).toBe(2);
  });
});
