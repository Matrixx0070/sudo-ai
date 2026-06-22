/**
 * HeadTailBuffer — bounded head+tail output capture.
 *
 * Covers the core invariant (head preserved, tail preserved, middle shed),
 * streaming across many small pushes, surrogate-pair safety on the tail cut,
 * stats accounting, and the clampHeadTail one-shot helper.
 */

import { describe, it, expect } from 'vitest';
import { HeadTailBuffer, clampHeadTail, clampToolOutput } from '../../../src/core/shared/head-tail-buffer.js';

/** True if `s` contains a lone (unpaired) UTF-16 surrogate code unit. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true; // high not followed by low
      i++; // valid pair — skip the low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // low with no preceding high
    }
  }
  return false;
}

describe('HeadTailBuffer', () => {
  it('returns content unchanged when it fits within head+tail budget', () => {
    const buf = new HeadTailBuffer({ headBudget: 10, tailBudget: 10 });
    buf.push('hello');
    expect(buf.toString()).toBe('hello');
    expect(buf.truncated).toBe(false);
    expect(buf.stats().droppedChars).toBe(0);
  });

  it('keeps the head and the tail, sheds the middle', () => {
    const buf = new HeadTailBuffer({ headBudget: 5, tailBudget: 5, elisionMarker: '<<{n}>>' });
    // 26 chars a..z
    buf.push('abcdefghijklmnopqrstuvwxyz');
    const out = buf.toString();
    expect(out).toBe('abcde\n<<16>>\nvwxyz');
    expect(out.startsWith('abcde')).toBe(true);
    expect(out.endsWith('vwxyz')).toBe(true);
    expect(buf.truncated).toBe(true);
    expect(buf.stats()).toEqual({
      totalChars: 26,
      keptChars: 10,
      droppedChars: 16,
      truncated: true,
    });
  });

  it('preserves the tail across many small streaming pushes', () => {
    const buf = new HeadTailBuffer({ headBudget: 3, tailBudget: 3 });
    for (let i = 0; i < 100; i++) buf.push(String(i % 10));
    const out = buf.toString();
    // head = first 3 digits "012", tail = last 3 digits of the 0..9 cycle
    expect(out.startsWith('012')).toBe(true);
    // last three chars pushed are "789" (99 -> 9, 98 -> 8, 97 -> 7)
    expect(out.endsWith('789')).toBe(true);
    expect(buf.length).toBe(100);
  });

  it('caps retained memory at head+tail regardless of input size', () => {
    const buf = new HeadTailBuffer({ headBudget: 100, tailBudget: 100 });
    for (let i = 0; i < 1000; i++) buf.push('x'.repeat(1000)); // 1,000,000 chars
    const out = buf.toString();
    expect(buf.length).toBe(1_000_000);
    // rendered output is head + marker + tail, far smaller than the input
    expect(out.length).toBeLessThan(300);
    expect(buf.stats().keptChars).toBe(200);
    expect(buf.stats().droppedChars).toBe(999_800);
  });

  it('never splits a surrogate pair when trimming the tail', () => {
    // Each 😀 is 2 UTF-16 code units. tailBudget=3 would cut mid-pair without guard.
    const buf = new HeadTailBuffer({ headBudget: 0, tailBudget: 3 });
    buf.push('A😀😀😀'); // A + three emoji = 1 + 6 = 7 code units
    const tail = buf.toString().split('\n').pop()!;
    // Valid UTF-16: no lone surrogate at the start
    const first = tail.charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    // The whole tail round-trips as well-formed (one full emoji)
    expect([...tail].length).toBeGreaterThanOrEqual(1);
  });

  it('never splits a surrogate pair at the head cut', () => {
    // headBudget=2 lands the cut between the high/low halves of the first 😀.
    // A long push forces a mid-string drop, so the head is separated from the
    // tail by the elision marker — without the guard the head would end in a
    // lone high surrogate (concatenation would otherwise re-join and hide it).
    const buf = new HeadTailBuffer({ headBudget: 2, tailBudget: 2, elisionMarker: '|CUT|' });
    buf.push('A😀BBBBBBBBBB'); // A + 😀(2 units) + B… ; cut at 2 splits the emoji
    const out = buf.toString();        // head + "\n" + marker + "\n" + tail
    expect(hasLoneSurrogate(out)).toBe(false);          // well-formed UTF-16
    expect(out.startsWith('A\n|CUT|\n')).toBe(true);    // stepped back to keep just 'A'
  });

  it('handles a zero-length head budget (tail-only)', () => {
    const buf = new HeadTailBuffer({ headBudget: 0, tailBudget: 4 });
    buf.push('abcdefgh');
    expect(buf.toString().endsWith('efgh')).toBe(true);
  });

  it('ignores empty pushes', () => {
    const buf = new HeadTailBuffer({ headBudget: 4, tailBudget: 4 });
    buf.push('');
    buf.push('ok');
    buf.push('');
    expect(buf.toString()).toBe('ok');
    expect(buf.length).toBe(2);
  });
});

describe('clampHeadTail', () => {
  it('is equivalent to pushing the whole string through a buffer', () => {
    const text = 'START' + 'm'.repeat(50) + 'END';
    const { text: clamped, truncated, droppedChars } = clampHeadTail(text, {
      headBudget: 5,
      tailBudget: 3,
    });
    expect(clamped.startsWith('START')).toBe(true);
    expect(clamped.endsWith('END')).toBe(true);
    expect(truncated).toBe(true);
    expect(droppedChars).toBe(text.length - 8);
  });

  it('returns short input unchanged and untruncated', () => {
    const { text, truncated } = clampHeadTail('tiny', { headBudget: 100, tailBudget: 100 });
    expect(text).toBe('tiny');
    expect(truncated).toBe(false);
  });
});

describe('clampToolOutput', () => {
  it('is identity for text within the default 8000-char budget', () => {
    const text = 'x'.repeat(8_000);
    const { text: out, truncated } = clampToolOutput(text);
    expect(out).toBe(text);
    expect(truncated).toBe(false);
  });

  it('clamps oversize text 50/50 and reports the original size in the marker', () => {
    const text = 'HEAD' + 'm'.repeat(20_000) + 'TAIL';
    const { text: out, truncated } = clampToolOutput(text);
    expect(truncated).toBe(true);
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toContain(`${text.length} total chars`);
    // head + marker line + tail stays near the budget
    expect(out.length).toBeLessThan(8_200);
  });

  it('honours a custom maxChars budget', () => {
    const text = 'a'.repeat(50) + 'b'.repeat(50);
    const { text: out, truncated } = clampToolOutput(text, 20);
    expect(truncated).toBe(true);
    expect(out).toContain('total chars');
    expect(out.startsWith('aaaaaaaaaa')).toBe(true);
    expect(out.endsWith('bbbbbbbbbb')).toBe(true);
  });
});
