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
import { parseAttachmentEnvelope } from '../../../src/core/channels/web.js';

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
