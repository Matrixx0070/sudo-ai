/**
 * normalizeBrainText — the single null-safe normalizer for Brain.chat() replies.
 * Brain.chat() resolves to a STRING; several call sites wrongly read `.content` and
 * crashed. This guards the contract for all of them.
 */
import { describe, it, expect } from 'vitest';
import { normalizeBrainText } from '../../src/core/brain/brain-text.js';

describe('normalizeBrainText', () => {
  it('returns a string reply unchanged (the real Brain.chat contract)', () => {
    expect(normalizeBrainText('hello world')).toBe('hello world');
    expect(normalizeBrainText('')).toBe('');
  });
  it('unwraps a legacy { content } object defensively', () => {
    expect(normalizeBrainText({ content: 'wrapped' })).toBe('wrapped');
  });
  it('returns "" for anything malformed — never throws (the crash class)', () => {
    expect(normalizeBrainText(undefined)).toBe('');
    expect(normalizeBrainText(null)).toBe('');
    expect(normalizeBrainText(42)).toBe('');
    expect(normalizeBrainText({})).toBe('');            // no content field
    expect(normalizeBrainText({ content: 123 })).toBe(''); // content not a string
    expect(normalizeBrainText([])).toBe('');
  });
});
