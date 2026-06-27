/**
 * Guards trimMemoryToFit — the rolling-buffer trim that lets _promoteToMemoryMd
 * keep saving learnings when MEMORY.md hits its 50KB cap (instead of silently
 * dropping new facts). Drops the OLDEST dated entries, keeps the header + newest.
 */
import { describe, it, expect } from 'vitest';
import { trimMemoryToFit } from '../../../src/core/memory/auto-dream.js';

function build(n: number): string {
  let s = '# Long-Term Memory\n\n';
  for (let i = 0; i < n; i++) {
    s += `- [2026-06-${String((i % 28) + 1).padStart(2, '0')}] fact number ${i} ${'x'.repeat(40)}\n`;
  }
  return s;
}

describe('trimMemoryToFit', () => {
  it('leaves content already under the target untouched', () => {
    const c = build(3);
    const { kept, trimmed } = trimMemoryToFit(c, 50 * 1024);
    expect(trimmed).toEqual([]);
    expect(kept).toBe(c); // already ends in a single newline
  });

  it('drops the OLDEST entries to fit, keeping the header + newest', () => {
    const c = build(100);
    const target = 2000;
    const { kept, trimmed } = trimMemoryToFit(c, target);

    expect(Buffer.byteLength(kept, 'utf-8')).toBeLessThanOrEqual(target);
    expect(kept.startsWith('# Long-Term Memory')).toBe(true);
    expect(trimmed.length).toBeGreaterThan(0);
    // oldest (fact 0) trimmed away; newest (fact 99) retained
    expect(trimmed.some((l) => l.includes('fact number 0 '))).toBe(true);
    expect(kept).toContain('fact number 99 ');
    expect(kept).not.toContain('fact number 0 ');
  });

  it('returns content unchanged when there are no dated entries to drop', () => {
    const c = '# Long-Term Memory\n\njust prose, no entries\n';
    const { kept, trimmed } = trimMemoryToFit(c, 10);
    expect(trimmed).toEqual([]);
    expect(kept).toBe(c);
  });

  it('keeps at least one entry even if it alone exceeds the target', () => {
    const big = 'y'.repeat(1000);
    const c = `# H\n\n- [2026-06-01] ${big}\n`;
    const { kept, trimmed } = trimMemoryToFit(c, 10);
    expect(trimmed).toEqual([]); // single entry is never dropped
    expect(kept).toContain(big);
  });
});
