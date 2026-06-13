/**
 * Two-tier compaction TIER 1 (gap #14) — zero-cost role-aware microcompact
 * primitive. Drives `microCompactMessages` end-to-end through head/tail
 * preservation, tool-message aggressive clamping, count/order invariants,
 * and the clamp() head+tail-with-marker shape.
 */

import { describe, it, expect } from 'vitest';
import {
  microCompactMessages,
  type MicroCompactMessage,
} from '../../src/core/agent/microcompact.js';

function makeMsg(role: MicroCompactMessage['role'], content: string): MicroCompactMessage {
  return { role, content };
}

describe('microCompactMessages', () => {
  it('returns the input unchanged when nothing is in the middle band', () => {
    // head=2 + tail=6 covers an 8-message list with zero middle to touch.
    const msgs = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'hi'),
      makeMsg('assistant', 'hello'),
      makeMsg('tool', 't'.repeat(10000)), // tail-protected, must NOT clamp
      makeMsg('user', 'q'),
      makeMsg('assistant', 'a'),
      makeMsg('user', 'q2'),
      makeMsg('assistant', 'a2'),
    ];
    const r = microCompactMessages(msgs);
    expect(r.messages).toHaveLength(8);
    expect(r.clamped).toBe(0);
    expect(r.charsBefore).toBe(r.charsAfter);
    // Tail tool message kept verbatim despite being huge
    expect(r.messages[3]?.content).toBe('t'.repeat(10000));
  });

  it('clamps middle tool messages hard while leaving head + tail untouched', () => {
    const big = 'X'.repeat(5000);
    const msgs: MicroCompactMessage[] = [
      makeMsg('system', 'system rules'),
      makeMsg('user', 'first user'),
      makeMsg('tool', big),     // middle — should clamp to 800 default
      makeMsg('assistant', big), // middle — should clamp to 4000 default
      makeMsg('user', 'q'),
      makeMsg('assistant', 'a'),
      makeMsg('user', 'q2'),
      makeMsg('assistant', 'a2'),
      makeMsg('user', 'q3'),
      makeMsg('assistant', 'a3'), // last 6 are tail
    ];
    const r = microCompactMessages(msgs);
    expect(r.messages).toHaveLength(10);
    expect(r.clamped).toBe(2);
    expect(r.dropped).toBe(0);
    expect(r.messages[0]?.content).toBe('system rules');
    expect(r.messages[1]?.content).toBe('first user');
    // Tool clamped to ~800 chars + marker, well under 5000.
    expect(r.messages[2]?.content.length).toBeLessThan(900);
    // Assistant clamped at the larger 4000 cap.
    expect(r.messages[3]?.content.length).toBeLessThan(4100);
    expect(r.charsAfter).toBeLessThan(r.charsBefore);
  });

  it('preserves message count, order, and role (never drops)', () => {
    const msgs: MicroCompactMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 3 === 0 ? 'assistant' : i % 3 === 1 ? 'tool' : 'user',
      content: 'p'.repeat(2000),
    }));
    const r = microCompactMessages(msgs);
    expect(r.messages).toHaveLength(20);
    expect(r.dropped).toBe(0);
    for (let i = 0; i < 20; i++) {
      expect(r.messages[i]?.role).toBe(msgs[i]?.role);
    }
  });

  it('preserves non-content metadata (tool_call ids) via structural spread', () => {
    const head = Array.from({ length: 2 }, () => makeMsg('system', 'h'));
    const middle: MicroCompactMessage = {
      role: 'tool',
      content: 'X'.repeat(2000),
      tool_call_id: 'call-42',
      name: 'system.exec',
    };
    const tail = Array.from({ length: 6 }, () => makeMsg('user', 't'));
    const r = microCompactMessages([...head, middle, ...tail]);
    const clampedMiddle = r.messages[2]!;
    expect(clampedMiddle.tool_call_id).toBe('call-42');
    expect(clampedMiddle.name).toBe('system.exec');
    expect(clampedMiddle.content.length).toBeLessThan(900);
  });

  it('preserves assistant.toolCalls[] across a clamped pass (Vercel AI SDK pairing)', () => {
    // Without this, the next tool-result message has no matching tool_call
    // and the SDK throws AI_MissingToolResultsError on brain.call().
    const toolCalls = [{ id: 'c1', name: 'bash', arguments: { cmd: 'ls' } }];
    const head = Array.from({ length: 2 }, () => makeMsg('system', 'h'));
    const middle: MicroCompactMessage = {
      role: 'assistant',
      content: 'Y'.repeat(10000),
      toolCalls,
    };
    const tail = Array.from({ length: 6 }, () => makeMsg('user', 't'));
    const r = microCompactMessages([...head, middle, ...tail]);
    expect(r.clamped).toBe(1);
    expect(r.messages[2]?.toolCalls).toBe(toolCalls);
    expect(r.messages[2]?.toolCalls?.[0]?.id).toBe('c1');
  });

  it('clamp marker reports accurately-dropped chars (not the naive s.length - maxChars)', () => {
    const original = 'X'.repeat(10000);
    const msgs: MicroCompactMessage[] = [
      makeMsg('system', ''),
      makeMsg('user', ''),
      makeMsg('tool', original),
      ...Array.from({ length: 6 }, () => makeMsg('user', '')),
    ];
    const r = microCompactMessages(msgs, { toolMessageMaxChars: 800 });
    const clampedContent = r.messages[2]!.content;
    const match = clampedContent.match(/\[trimmed (\d+) chars\]/);
    expect(match).not.toBeNull();
    const reported = Number(match![1]);
    // dropped = original.length - (head + tail bytes); marker chars are not "dropped" — they replace.
    const headTailBytes = clampedContent.length - match![0].length - 2; // minus marker text + 2 \n
    const actualDropped = original.length - headTailBytes;
    // Within a couple chars (digit-count drift between probe and final marker).
    expect(Math.abs(reported - actualDropped)).toBeLessThanOrEqual(2);
  });

  it('records charsBefore/charsAfter accurately', () => {
    const msgs = [
      makeMsg('system', 'a'.repeat(10)),
      makeMsg('user', 'b'.repeat(20)),
      makeMsg('tool', 'c'.repeat(5000)), // middle
      ...Array.from({ length: 6 }, () => makeMsg('user', 'd'.repeat(30))),
    ];
    const expectedBefore = 10 + 20 + 5000 + 6 * 30;
    const r = microCompactMessages(msgs);
    expect(r.charsBefore).toBe(expectedBefore);
    expect(r.charsAfter).toBeLessThan(r.charsBefore);
    expect(r.charsAfter).toBe(
      r.messages.reduce((s, m) => s + m.content.length, 0),
    );
  });

  it('clamp() shape: keeps a head + [trimmed N chars] marker + tail', () => {
    const original = 'A'.repeat(3000) + 'B'.repeat(3000);
    const msgs = [
      makeMsg('system', ''),
      makeMsg('user', ''),
      makeMsg('tool', original),
      ...Array.from({ length: 6 }, () => makeMsg('user', '')),
    ];
    const r = microCompactMessages(msgs);
    const c = r.messages[2]!.content;
    expect(c).toMatch(/\[trimmed \d+ chars\]/);
    expect(c.startsWith('A')).toBe(true);
    expect(c.endsWith('B')).toBe(true);
  });

  it('does not clamp small messages even when in the middle band', () => {
    const msgs = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'first'),
      makeMsg('tool', 'small tool result'), // 17 chars, well under 800
      makeMsg('assistant', 'short reply'),  // well under 4000
      ...Array.from({ length: 6 }, () => makeMsg('user', 'tail')),
    ];
    const r = microCompactMessages(msgs);
    expect(r.clamped).toBe(0);
    expect(r.charsBefore).toBe(r.charsAfter);
  });

  it('respects custom caps', () => {
    const msgs = [
      makeMsg('system', 'a'),
      makeMsg('user', 'b'),
      makeMsg('tool', 'c'.repeat(2000)),
      ...Array.from({ length: 6 }, () => makeMsg('user', 't')),
    ];
    const r = microCompactMessages(msgs, { toolMessageMaxChars: 200 });
    expect(r.messages[2]!.content.length).toBeLessThanOrEqual(200);
  });

  it('does not mutate the input array', () => {
    const middleContent = 'X'.repeat(5000);
    const msgs: MicroCompactMessage[] = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'u'),
      { role: 'tool', content: middleContent },
      ...Array.from({ length: 6 }, () => makeMsg('user', 'tail')),
    ];
    const snapshot = msgs.map((m) => ({ ...m }));
    microCompactMessages(msgs);
    for (let i = 0; i < msgs.length; i++) {
      expect(msgs[i]?.content).toBe(snapshot[i]?.content);
      expect(msgs[i]?.role).toBe(snapshot[i]?.role);
    }
    // The big middle tool content is still the original 5000-char string.
    expect(msgs[2]?.content.length).toBe(5000);
  });

  it('handles empty / undefined content fields without throwing', () => {
    const msgs: MicroCompactMessage[] = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'u'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { role: 'tool', content: undefined as any },
      makeMsg('assistant', ''),
      ...Array.from({ length: 6 }, () => makeMsg('user', 't')),
    ];
    const r = microCompactMessages(msgs);
    expect(r.messages).toHaveLength(10);
    expect(r.clamped).toBe(0);
  });

  it('"system" middle messages pass through untouched (small directives)', () => {
    const msgs: MicroCompactMessage[] = [
      makeMsg('system', 'h1'),
      makeMsg('user', 'u'),
      makeMsg('system', 'X'.repeat(8000)), // middle system — left alone by design
      ...Array.from({ length: 6 }, () => makeMsg('user', 't')),
    ];
    const r = microCompactMessages(msgs);
    expect(r.clamped).toBe(0);
    expect(r.messages[2]?.content.length).toBe(8000);
  });
});
