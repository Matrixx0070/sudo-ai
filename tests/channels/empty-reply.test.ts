/**
 * empty-reply normalization (outage fix).
 *
 * Regression guard for the Telegram silence bug: a content-filtered /
 * phantom-completion turn returns an EMPTY string (not null), which slipped
 * past `result.text ?? fallback` and 400'd Telegram's editMessageText — so a
 * refusal presented as total silence and poisoned every later message in the
 * session.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeReplyText,
  isEmptyReply,
  EMPTY_REPLY_FALLBACK,
} from '../../src/core/channels/empty-reply.js';

describe('isEmptyReply', () => {
  it('treats null, undefined, "", and whitespace as empty', () => {
    expect(isEmptyReply(null)).toBe(true);
    expect(isEmptyReply(undefined)).toBe(true);
    expect(isEmptyReply('')).toBe(true);
    expect(isEmptyReply('   \n\t ')).toBe(true);
  });
  it('treats real content as non-empty', () => {
    expect(isEmptyReply('hi')).toBe(false);
    expect(isEmptyReply('  hi  ')).toBe(false);
  });
});

describe('normalizeReplyText', () => {
  it('passes real text through unchanged', () => {
    expect(normalizeReplyText('hello there', false)).toBe('hello there');
  });

  it('substitutes the fallback for an EMPTY string with no attachments (the bug)', () => {
    // This is exactly what a content-filter turn produced: "" not null.
    expect(normalizeReplyText('', false)).toBe(EMPTY_REPLY_FALLBACK);
    expect(normalizeReplyText(undefined, false)).toBe(EMPTY_REPLY_FALLBACK);
    expect(normalizeReplyText('   ', false)).toBe(EMPTY_REPLY_FALLBACK);
  });

  it('does NOT inject text when attachments carry the reply', () => {
    expect(normalizeReplyText('', true)).toBe('');
    expect(normalizeReplyText(null, true)).toBe('');
  });

  it('fallback is non-empty and mentions /reset (so Telegram never 400s and the user gets an action)', () => {
    expect(EMPTY_REPLY_FALLBACK.trim().length).toBeGreaterThan(0);
    expect(EMPTY_REPLY_FALLBACK).toContain('/reset');
  });
});
