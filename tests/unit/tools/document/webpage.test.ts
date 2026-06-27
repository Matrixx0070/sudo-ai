/**
 * Guards ensureHtmlDocument — the wrapper behind document.webpage. A bare fragment
 * becomes a complete responsive document; a full document is trusted as-is (no
 * double-wrap). The chromium preview + file write are exercised by live e2e.
 */
import { describe, it, expect } from 'vitest';
import { ensureHtmlDocument } from '../../../../src/core/tools/builtin/document/tools/webpage.js';

describe('ensureHtmlDocument', () => {
  it('wraps a bare fragment in a complete responsive document', () => {
    const out = ensureHtmlDocument('<h1>Hi</h1><button onclick="alert(1)">x</button>', 'My Page');
    expect(out.toLowerCase()).toContain('<!doctype html>');
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('width=device-width');
    expect(out).toContain('<title>My Page</title>');
    expect(out).toContain('<h1>Hi</h1>'); // the fragment is preserved
    expect(out).toContain('onclick="alert(1)"'); // inline JS preserved (interactive)
  });

  it('defaults the title when none is given', () => {
    expect(ensureHtmlDocument('<p>x</p>')).toContain('<title>Webpage</title>');
  });

  it('passes a full document through unchanged (no double-wrap)', () => {
    const full = '<!doctype html><html><head><title>Real</title></head><body>hi</body></html>';
    expect(ensureHtmlDocument(full, 'Ignored')).toBe(full);
    const htmlTag = '<html lang="en"><head></head><body>hi</body></html>';
    expect(ensureHtmlDocument(htmlTag)).toBe(htmlTag);
    // exactly one doctype → not wrapped again
    expect((ensureHtmlDocument(full).match(/<!doctype/gi) || []).length).toBe(1);
  });

  it('escapes the title to prevent markup injection', () => {
    const out = ensureHtmlDocument('<p>x</p>', '</title><script>evil()</script>');
    expect(out).not.toContain('<script>evil()');
    expect(out).toContain('&lt;script&gt;');
  });
});
