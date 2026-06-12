/**
 * MessageCoalescer — burst debounce/coalesce, foreground-reply fence,
 * combineMessages merging, and group-chat mention gating.
 *
 * Uses real timers with small windows (20-40 ms) to exercise actual
 * scheduling rather than mocking setTimeout.
 */

import { describe, it, expect } from 'vitest';
import {
  MessageCoalescer,
  combineMessages,
  isAddressedToBot,
} from '../../src/core/channels/message-coalescer.js';
import type { UnifiedMessage } from '../../src/core/channels/types.js';

let nextId = 0;
function msg(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  nextId++;
  return {
    id: String(nextId),
    channel: 'telegram',
    peerId: 'peer-1',
    peerName: 'Tester',
    chatType: 'dm',
    text: `message ${nextId}`,
    timestamp: new Date(),
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('combineMessages', () => {
  it('returns a single message unchanged', () => {
    const m = msg({ text: 'solo' });
    expect(combineMessages([m])).toBe(m);
  });

  it('joins texts in order and keeps the last message metadata', () => {
    const a = msg({ text: 'first', id: 'a' });
    const b = msg({ text: 'second', id: 'b', replyToId: 'r1' });
    const combined = combineMessages([a, b]);
    expect(combined.text).toBe('first\nsecond');
    expect(combined.id).toBe('b');
    expect(combined.replyToId).toBe('r1');
  });

  it('drops empty texts and concatenates media', () => {
    const a = msg({ text: '', media: [{ mimeType: 'image/png', type: 'image' }] });
    const b = msg({ text: 'caption', media: [{ mimeType: 'image/jpeg', type: 'image' }] });
    const combined = combineMessages([a, b]);
    expect(combined.text).toBe('caption');
    expect(combined.media).toHaveLength(2);
  });

  it('throws on an empty batch', () => {
    expect(() => combineMessages([])).toThrow();
  });

  it('tolerates undefined text from media-only adapter messages', () => {
    const a = msg({ text: undefined as unknown as string, media: [{ mimeType: 'image/png', type: 'image' }] });
    const b = msg({ text: 'caption' });
    expect(combineMessages([a, b]).text).toBe('caption');
  });
});

describe('MessageCoalescer', () => {
  it('coalesces a burst within the debounce window into one delivery', async () => {
    const delivered: UnifiedMessage[] = [];
    const c = new MessageCoalescer({
      debounceMs: 30,
      deliver: async (m) => { delivered.push(m); },
    });

    c.push(msg({ text: 'one' }));
    c.push(msg({ text: 'two' }));
    c.push(msg({ text: 'three' }));
    await sleep(80);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toBe('one\ntwo\nthree');
    expect(c.pendingChats).toBe(0);
  });

  it('keeps separate chats independent', async () => {
    const delivered: UnifiedMessage[] = [];
    const c = new MessageCoalescer({
      debounceMs: 20,
      deliver: async (m) => { delivered.push(m); },
    });

    c.push(msg({ peerId: 'alice', text: 'hi from alice' }));
    c.push(msg({ peerId: 'bob', text: 'hi from bob' }));
    await sleep(60);

    expect(delivered).toHaveLength(2);
    const texts = delivered.map((m) => m.text).sort();
    expect(texts).toEqual(['hi from alice', 'hi from bob']);
  });

  it('holds messages behind the reply fence and flushes them as the next turn', async () => {
    const delivered: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });

    const c = new MessageCoalescer({
      debounceMs: 10,
      deliver: async (m) => {
        delivered.push(m.text);
        if (delivered.length === 1) await firstGate; // simulate slow agent turn
      },
    });

    c.push(msg({ text: 'turn-1' }));
    await sleep(30); // first delivery starts and blocks on the gate

    // These arrive while the agent is composing turn-1.
    c.push(msg({ text: 'mid-a' }));
    c.push(msg({ text: 'mid-b' }));
    await sleep(30);
    expect(delivered).toEqual(['turn-1']); // fence held them

    releaseFirst();
    await sleep(30);

    expect(delivered).toEqual(['turn-1', 'mid-a\nmid-b']);
  });

  it('forces delivery when maxBuffered is reached', async () => {
    const delivered: UnifiedMessage[] = [];
    const c = new MessageCoalescer({
      debounceMs: 10_000, // window never elapses in this test
      maxBuffered: 3,
      deliver: async (m) => { delivered.push(m); },
    });

    c.push(msg({ text: 'a' }));
    c.push(msg({ text: 'b' }));
    c.push(msg({ text: 'c' }));
    await sleep(20);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toBe('a\nb\nc');
  });

  it('continues after a delivery failure and still flushes later messages', async () => {
    const delivered: string[] = [];
    let calls = 0;
    const c = new MessageCoalescer({
      debounceMs: 10,
      deliver: async (m) => {
        calls++;
        if (calls === 1) throw new Error('agent turn exploded');
        delivered.push(m.text);
      },
    });

    c.push(msg({ text: 'doomed' }));
    await sleep(40);
    c.push(msg({ text: 'recovered' }));
    await sleep(40);

    expect(calls).toBe(2);
    expect(delivered).toEqual(['recovered']);
  });

  it('drain() delivers everything pending immediately', async () => {
    const delivered: UnifiedMessage[] = [];
    const c = new MessageCoalescer({
      debounceMs: 10_000,
      deliver: async (m) => { delivered.push(m); },
    });

    c.push(msg({ peerId: 'x', text: 'pending-x' }));
    c.push(msg({ peerId: 'y', text: 'pending-y' }));
    await c.drain();

    expect(delivered).toHaveLength(2);
  });

  it('drain() does not drop messages held behind an in-flight fence', async () => {
    const delivered: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });

    const c = new MessageCoalescer({
      debounceMs: 10,
      deliver: async (m) => {
        delivered.push(m.text);
        if (delivered.length === 1) await firstGate;
      },
    });

    c.push(msg({ text: 'turn-1' }));
    await sleep(30); // delivery in flight, blocked on the gate
    c.push(msg({ text: 'held-behind-fence' }));

    setTimeout(releaseFirst, 30);
    await c.drain();

    expect(delivered).toEqual(['turn-1', 'held-behind-fence']);
    expect(c.pendingChats).toBe(0);
  });
});

describe('isAddressedToBot', () => {
  it('always handles DMs', () => {
    expect(isAddressedToBot(msg({ chatType: 'dm', text: 'no mention here' }), ['sudobot'])).toBe(true);
  });

  it('handles group messages that mention the bot (case-insensitive)', () => {
    expect(isAddressedToBot(msg({ chatType: 'group', text: 'hey @SudoBot do it' }), ['sudobot'])).toBe(true);
    expect(isAddressedToBot(msg({ chatType: 'group', text: '@sudobot ping' }), ['@SudoBot'])).toBe(true);
  });

  it('gates group messages without a mention', () => {
    expect(isAddressedToBot(msg({ chatType: 'group', text: 'just chatting' }), ['sudobot'])).toBe(false);
    expect(isAddressedToBot(msg({ chatType: 'group', text: 'email me @ home' }), ['sudobot'])).toBe(false);
  });

  it('fails open when no bot names are known', () => {
    expect(isAddressedToBot(msg({ chatType: 'group', text: 'anything' }), [])).toBe(true);
    expect(isAddressedToBot(msg({ chatType: 'group', text: 'anything' }), ['', '@'])).toBe(true);
  });
});
