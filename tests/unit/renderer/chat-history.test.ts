/**
 * Guards the web-chat history persistence helpers (src/renderer/chat/history.ts).
 * These are pure (no DOM) so they run in the node vitest env: media messages
 * collapse to compact markers, empty messages are dropped, the list is capped,
 * and a serialize→deserialize round-trip preserves role/content/timestamp.
 */
import { describe, it, expect } from 'vitest';
import { serializeHistory, deserializeHistory } from '../../../src/renderer/chat/history.js';
import type { Message } from '../../../src/renderer/chat/hooks/useChatSession.js';

const ts = new Date('2026-06-27T05:30:00.000Z');

describe('serializeHistory', () => {
  it('keeps text content and stamps an ISO timestamp', () => {
    const out = serializeHistory([{ role: 'user', content: 'hello', timestamp: ts }]);
    expect(out).toEqual([{ role: 'user', content: 'hello', timestamp: ts.toISOString() }]);
  });

  it('replaces media (no caption) with a compact marker', () => {
    const msgs: Message[] = [
      { role: 'user', content: '', timestamp: ts, imageUrl: 'blob:x' },
      { role: 'ai', content: '', timestamp: ts, audioUrl: 'data:audio/wav;base64,AA' },
      { role: 'user', content: '', timestamp: ts, fileUrl: 'data:x', fileName: 'report.pdf' },
    ];
    expect(serializeHistory(msgs).map((m) => m.content)).toEqual(['🖼 Image', '🔊 Voice note', '📎 report.pdf']);
  });

  it('keeps a caption when one accompanies media', () => {
    const out = serializeHistory([{ role: 'user', content: 'look at this', timestamp: ts, imageUrl: 'blob:x' }]);
    expect(out[0]!.content).toBe('look at this');
  });

  it('drops messages that would serialize to empty', () => {
    expect(serializeHistory([{ role: 'ai', content: '   ', timestamp: ts }])).toEqual([]);
  });

  it('caps to the most recent N', () => {
    const many: Message[] = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `m${i}`, timestamp: ts }));
    const out = serializeHistory(many, 3);
    expect(out.map((m) => m.content)).toEqual(['m7', 'm8', 'm9']);
  });
});

describe('deserializeHistory', () => {
  it('round-trips role/content/timestamp', () => {
    const stored = serializeHistory([
      { role: 'user', content: 'hi', timestamp: ts },
      { role: 'ai', content: 'hello back', timestamp: ts },
    ]);
    const back = deserializeHistory(JSON.stringify(stored));
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(back[0]!.timestamp.toISOString()).toBe(ts.toISOString());
  });

  it('returns [] for invalid JSON or non-array', () => {
    expect(deserializeHistory('not json')).toEqual([]);
    expect(deserializeHistory('{"a":1}')).toEqual([]);
  });

  it('skips malformed entries and recovers a bad timestamp to a valid Date', () => {
    const back = deserializeHistory(JSON.stringify([
      { role: 'bogus', content: 'x', timestamp: ts.toISOString() },
      { role: 'user', content: 'ok', timestamp: 'not-a-date' },
      { role: 'ai' },
    ]));
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ role: 'user', content: 'ok' });
    expect(isNaN(back[0]!.timestamp.getTime())).toBe(false);
  });
});
