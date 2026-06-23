/**
 * @file telegram-media.test.ts
 * @description Regression for "send any file through Telegram → received as empty
 * content" (AgentLoop.run: message must be a non-empty string). The document
 * handler used to forward the Telegram caption straight through; a caption-less
 * file produced empty text. buildDocumentInbound now always yields non-empty text.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDocumentInbound,
  isTextLikeFile,
  DOC_PREVIEW_MAX_CHARS,
} from '../../src/core/channels/telegram-media.js';

describe('isTextLikeFile', () => {
  it('matches text mime types + source/text extensions (ext wins over generic mime)', () => {
    expect(isTextLikeFile('text/plain', 'a.txt')).toBe(true);
    expect(isTextLikeFile('application/json', 'a.json')).toBe(true);
    expect(isTextLikeFile('application/octet-stream', 'script.py')).toBe(true);
    expect(isTextLikeFile('application/octet-stream', 'main.ts')).toBe(true);
  });
  it('rejects binary types', () => {
    expect(isTextLikeFile('application/pdf', 'report.pdf')).toBe(false);
    expect(isTextLikeFile('image/png', 'pic.png')).toBe(false);
    expect(isTextLikeFile('application/octet-stream', 'blob.bin')).toBe(false);
  });
});

describe('buildDocumentInbound — the caption-less-file fix', () => {
  it('produces NON-EMPTY text for a file with no caption (the bug)', () => {
    const { text, media } = buildDocumentInbound({
      caption: '',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      savedPath: '/data/uploads/abc-report.pdf',
    });
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain('report.pdf');
    expect(text).toContain('/data/uploads/abc-report.pdf');
    expect(media[0]).toMatchObject({
      type: 'document',
      filename: 'report.pdf',
      url: '/data/uploads/abc-report.pdf',
    });
  });

  it('inlines contents for a small text-like file', () => {
    const { text } = buildDocumentInbound({
      caption: '',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      savedPath: '/u/notes.md',
      buffer: Buffer.from('# Hello\nworld'),
    });
    expect(text).toContain('# Hello');
    expect(text).toContain('world');
  });

  it('truncates a large text preview', () => {
    const big = 'x'.repeat(DOC_PREVIEW_MAX_CHARS + 5000);
    const { text } = buildDocumentInbound({
      caption: '',
      filename: 'big.txt',
      mimeType: 'text/plain',
      savedPath: '/u/big.txt',
      buffer: Buffer.from(big),
    });
    expect(text).toContain('truncated');
    expect(text.length).toBeLessThan(big.length);
  });

  it('does NOT inline a binary file — just surfaces the path', () => {
    const { text } = buildDocumentInbound({
      caption: '',
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      savedPath: '/u/a.pdf',
      buffer: Buffer.from([0, 1, 2, 3]),
    });
    expect(text).toContain('Read it from that path');
    expect(text).toContain('a.pdf');
  });

  it('prepends the caption when present', () => {
    const { text } = buildDocumentInbound({
      caption: 'please review',
      filename: 'a.txt',
      mimeType: 'text/plain',
      savedPath: '/u/a.txt',
      buffer: Buffer.from('hi'),
    });
    expect(text.startsWith('please review')).toBe(true);
    expect(text).toContain('a.txt');
  });

  it('still gives non-empty text when the download failed (no savedPath)', () => {
    const { text, media } = buildDocumentInbound({
      caption: '',
      filename: 'a.zip',
      mimeType: 'application/zip',
    });
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain('download failed');
    expect(media[0]?.url).toBeUndefined();
  });
});
