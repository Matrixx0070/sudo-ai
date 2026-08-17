/**
 * @file tests/channels/stream-markdown.test.ts
 * @description The partial-markdown stabilizer for streaming frames: every frame
 * must be well-formed (balanced spans, closed fences) with the cursor placed at
 * the typing point, and ordinary prose must never trip a false span.
 */

import { describe, it, expect } from 'vitest';
import { stabilizeStreamingMarkdown as s } from '../../src/core/channels/stream-markdown.js';

const CUR = '▌';

describe('stabilizeStreamingMarkdown', () => {
  it('empty buffer → just the cursor', () => {
    expect(s('', CUR)).toBe('▌');
  });

  it('plain text → cursor at the end, untouched', () => {
    expect(s('The lighthouse', CUR)).toBe('The lighthouse▌');
  });

  it('closes an open bold span with the cursor inside it', () => {
    expect(s('The **lighthouse', CUR)).toBe('The **lighthouse▌**');
  });

  it('closes an open inline-code span', () => {
    expect(s('run `npm', CUR)).toBe('run `npm▌`');
  });

  it('closes nested spans in LIFO order', () => {
    expect(s('**bold and _italic', CUR)).toBe('**bold and _italic▌_**');
  });

  it('balances a completed bold (no extra closer)', () => {
    expect(s('**done**', CUR)).toBe('**done**▌');
  });

  it('closes an open ``` code fence after the cursor', () => {
    expect(s('```py\nprint(1)', CUR)).toBe('```py\nprint(1)▌\n```');
  });

  it('treats inline-code contents as literal (backtick-wrapped * is not a span)', () => {
    expect(s('`a * b`', CUR)).toBe('`a * b`▌');
  });

  it('does NOT create a false italic span from arithmetic "2 * 3"', () => {
    expect(s('2 * 3', CUR)).toBe('2 * 3▌');
  });

  it('does NOT treat snake_case as an italic span', () => {
    expect(s('call foo_bar', CUR)).toBe('call foo_bar▌');
  });

  it('closes an open strikethrough', () => {
    expect(s('~~oops', CUR)).toBe('~~oops▌~~');
  });

  it('leaves a lone trailing marker as literal text (no empty span)', () => {
    // "word *" — space before the marker means it does not open emphasis.
    expect(s('word *', CUR)).toBe('word *▌');
  });
});
