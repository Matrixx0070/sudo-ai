/**
 * Guards normalizePathsArg behind document.pdf-merge — the LLM may pass the file
 * list as a JSON string or a comma/newline-separated string. The poppler round-trip
 * (pdfunite / pdfseparate) is exercised by the one-off + live e2e.
 */
import { describe, it, expect } from 'vitest';
import { normalizePathsArg } from '../../../../src/core/tools/builtin/document/tools/pdf-edit.js';

describe('normalizePathsArg', () => {
  it('passes a real array through, trimming', () => {
    expect(normalizePathsArg(['/tmp/a.pdf', ' /tmp/b.pdf '])).toEqual(['/tmp/a.pdf', '/tmp/b.pdf']);
  });

  it('parses a JSON-string array', () => {
    expect(normalizePathsArg('["/tmp/a.pdf","/tmp/b.pdf"]')).toEqual(['/tmp/a.pdf', '/tmp/b.pdf']);
  });

  it('splits a comma- or newline-separated string', () => {
    expect(normalizePathsArg('/tmp/a.pdf, /tmp/b.pdf')).toEqual(['/tmp/a.pdf', '/tmp/b.pdf']);
    expect(normalizePathsArg('/tmp/a.pdf\n/tmp/b.pdf')).toEqual(['/tmp/a.pdf', '/tmp/b.pdf']);
  });

  it('drops empties; non-array/garbage → []', () => {
    expect(normalizePathsArg(['/tmp/a.pdf', '', '  '])).toEqual(['/tmp/a.pdf']);
    expect(normalizePathsArg(42)).toEqual([]);
    expect(normalizePathsArg(null)).toEqual([]);
  });
});
