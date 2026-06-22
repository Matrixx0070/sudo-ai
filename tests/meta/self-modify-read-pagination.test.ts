/**
 * Regression for meta.self-modify `read-file`. It used to pipe every file
 * through the 3000-char `trim()` cap (first 1500 + "...[truncated]..." + last
 * 1500), gutting the MIDDLE of any file over ~80 lines. A live drill showed the
 * agent re-reading a 198-line source file 5× because the part it needed was the
 * part that got cut. Reads now return the whole file (capped large files page
 * from the END, never the middle) and expose offset/limit.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { doReadFile } from '../../src/core/tools/builtin/meta/self-modify.js';

const TMP_DIR = path.join(process.cwd(), 'data', 'tmp-read-pagination-test');
mkdirSync(TMP_DIR, { recursive: true });

function fixture(name: string, lines: string[]): string {
  const p = path.join(TMP_DIR, name);
  writeFileSync(p, lines.join('\n'), 'utf-8');
  return p;
}

afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

describe('meta.self-modify read-file — no middle truncation', () => {
  it('returns the whole of a >3000-char file without gutting the middle', () => {
    // 200 lines, well over the old 3000-char cap, with a unique middle marker.
    const lines = Array.from({ length: 200 }, (_, i) =>
      i === 100 ? 'MIDDLE_MARKER_UNIQUE_TOKEN' : `line ${i} ${'x'.repeat(30)}`,
    );
    const p = fixture('big.ts', lines);
    const r = doReadFile(p);

    expect(r.success).toBe(true);
    expect(r.output).toContain('MIDDLE_MARKER_UNIQUE_TOKEN');     // middle survives
    expect(r.output).not.toContain('...[truncated]...');         // old gutting gone
    expect((r.data as { truncated: boolean }).truncated).toBe(false);
    expect((r.data as { linesReturned: number }).linesReturned).toBe(200);
  });

  it('pages a very large file from the END with an offset hint, never the middle', () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `row ${i}`);
    const p = fixture('huge.ts', lines);

    const first = doReadFile(p); // default limit 500
    expect((first.data as { truncated: boolean }).truncated).toBe(true);
    expect((first.data as { linesReturned: number }).linesReturned).toBe(500);
    expect(first.output).toContain('Pass offset=501 to read more');
    expect(first.output).toContain('row 0');
    expect(first.output).toContain('row 499');
    expect(first.output).not.toContain('row 500'); // cut at the end, contiguous

    const second = doReadFile(p, 501); // continue where the hint pointed
    expect(second.output).toContain('row 500');
    expect(second.output).toContain('row 999');

    const third = doReadFile(p, 1001); // final page reaches the real tail
    expect(third.output).toContain('row 1000');
    expect(third.output).toContain('row 1199');
    expect((third.data as { truncated: boolean }).truncated).toBe(false);
  });

  it('honors an explicit limit', () => {
    const p = fixture('limited.ts', Array.from({ length: 50 }, (_, i) => `n${i}`));
    const r = doReadFile(p, 1, 10);
    expect((r.data as { linesReturned: number }).linesReturned).toBe(10);
    expect((r.data as { truncated: boolean }).truncated).toBe(true);
    expect(r.output).toContain('n0');
    expect(r.output).toContain('n9');
    expect(r.output).not.toContain('n10');
  });
});
