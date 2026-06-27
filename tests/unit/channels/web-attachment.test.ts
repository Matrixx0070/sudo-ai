/**
 * Guards the WS attachment-envelope discriminator in web.ts.
 *
 * The browser uploads a file by sending a JSON `{ type:'__attachment', ... }`
 * frame over the same /chat/ws socket it uses for plain-text messages. The
 * parser must accept well-formed envelopes and reject EVERYTHING else — most
 * importantly plain text that happens to be valid JSON — so normal messages
 * never get mis-routed into the upload path.
 */
import { describe, it, expect } from 'vitest';
import { parseAttachmentEnvelope, buildMediaReplyFrame, broadcastToSockets } from '../../../src/core/channels/web.js';

describe('parseAttachmentEnvelope', () => {
  it('accepts a well-formed envelope (with caption)', () => {
    const env = parseAttachmentEnvelope(JSON.stringify({
      type: '__attachment',
      name: 'cat.png',
      mime: 'image/png',
      dataBase64: 'aGVsbG8=',
      caption: 'look at this',
    }));
    expect(env).not.toBeNull();
    expect(env).toMatchObject({ name: 'cat.png', mime: 'image/png', dataBase64: 'aGVsbG8=', caption: 'look at this' });
  });

  it('accepts an envelope without a caption (caption omitted, not null)', () => {
    const env = parseAttachmentEnvelope(JSON.stringify({
      type: '__attachment', name: 'a.pdf', mime: 'application/pdf', dataBase64: 'eA==',
    }));
    expect(env).not.toBeNull();
    expect(env!.caption).toBeUndefined();
  });

  it('rejects plain text', () => {
    expect(parseAttachmentEnvelope('hello there')).toBeNull();
    expect(parseAttachmentEnvelope('')).toBeNull();
  });

  it('rejects plain text that is valid JSON but not an attachment', () => {
    expect(parseAttachmentEnvelope('{"foo":1}')).toBeNull();
    expect(parseAttachmentEnvelope('{"type":"reply","content":"hi"}')).toBeNull();
    expect(parseAttachmentEnvelope('[1,2,3]')).toBeNull();
    expect(parseAttachmentEnvelope('"just a string"')).toBeNull();
    expect(parseAttachmentEnvelope('42')).toBeNull();
  });

  it('rejects an attachment envelope missing required fields', () => {
    expect(parseAttachmentEnvelope(JSON.stringify({ type: '__attachment', name: 'x.png', mime: 'image/png' }))).toBeNull();
    expect(parseAttachmentEnvelope(JSON.stringify({ type: '__attachment', name: 'x.png', dataBase64: 'eA==' }))).toBeNull();
    expect(parseAttachmentEnvelope(JSON.stringify({ type: '__attachment', mime: 'image/png', dataBase64: 'eA==' }))).toBeNull();
  });

  it('rejects an envelope whose required fields are the wrong type', () => {
    expect(parseAttachmentEnvelope(JSON.stringify({ type: '__attachment', name: 5, mime: 'image/png', dataBase64: 'eA==' }))).toBeNull();
    expect(parseAttachmentEnvelope(JSON.stringify({ type: '__attachment', name: 'x', mime: 'image/png', dataBase64: 123 }))).toBeNull();
  });

  it('ignores a non-string caption rather than failing', () => {
    const env = parseAttachmentEnvelope(JSON.stringify({
      type: '__attachment', name: 'x.png', mime: 'image/png', dataBase64: 'eA==', caption: { not: 'a string' },
    }));
    expect(env).not.toBeNull();
    expect(env!.caption).toBeUndefined();
  });
});

describe('buildMediaReplyFrame', () => {
  it('builds a reply frame the SPA renders as inline media', () => {
    const frame = JSON.parse(buildMediaReplyFrame({
      type: 'audio', mimeType: 'audio/wav', filename: 'hello.wav', dataBase64: 'aGk=',
    }));
    expect(frame).toEqual({
      type: 'reply',
      content: '',
      media: [{ type: 'audio', mimeType: 'audio/wav', filename: 'hello.wav', dataBase64: 'aGk=' }],
    });
  });

  it('defaults a missing filename to "file"', () => {
    const frame = JSON.parse(buildMediaReplyFrame({ type: 'image', mimeType: 'image/png', dataBase64: 'eA==' }));
    expect(frame.media[0].filename).toBe('file');
  });
});

describe('broadcastToSockets (multi-tab fan-out)', () => {
  const mkSocket = () => {
    const sent: string[] = [];
    return { OPEN: 1, readyState: 1, send: (s: string) => sent.push(s), sent };
  };

  it('delivers to every open socket and counts them', () => {
    const a = mkSocket();
    const b = mkSocket();
    expect(broadcastToSockets([a, b], 'hi')).toBe(2);
    expect(a.sent).toEqual(['hi']);
    expect(b.sent).toEqual(['hi']);
  });

  it('skips a non-open socket', () => {
    const open = mkSocket();
    const closed = { OPEN: 1, readyState: 3, send: () => { throw new Error('should not send'); } };
    expect(broadcastToSockets([open, closed], 'x')).toBe(1);
    expect(open.sent).toEqual(['x']);
  });

  it('continues past a throwing socket', () => {
    const bad = { OPEN: 1, readyState: 1, send: () => { throw new Error('boom'); } };
    const good = mkSocket();
    expect(broadcastToSockets([bad, good], 'y')).toBe(1);
    expect(good.sent).toEqual(['y']);
  });

  it('returns 0 for an empty set', () => {
    expect(broadcastToSockets([], 'z')).toBe(0);
  });
});
