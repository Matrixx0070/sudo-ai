/**
 * Guards normalizeMermaidTheme + mermaidBackground behind media.mermaid. The actual
 * Mermaid render (chromium + mermaid.min.js) is exercised by live e2e.
 */
import { describe, it, expect } from 'vitest';
import { normalizeMermaidTheme, mermaidBackground } from '../../../../src/core/tools/builtin/media/tools/mermaid.js';

describe('normalizeMermaidTheme', () => {
  it('accepts the known themes', () => {
    for (const t of ['default', 'dark', 'forest', 'neutral']) {
      expect(normalizeMermaidTheme(t)).toBe(t);
    }
  });

  it('falls back to default for unknown/missing values', () => {
    expect(normalizeMermaidTheme('rainbow')).toBe('default');
    expect(normalizeMermaidTheme(undefined)).toBe('default');
    expect(normalizeMermaidTheme(42)).toBe('default');
  });
});

describe('mermaidBackground', () => {
  it('uses a dark page background only for the dark theme', () => {
    expect(mermaidBackground('dark')).toBe('#1e1e2e');
    expect(mermaidBackground('default')).toBe('#ffffff');
    expect(mermaidBackground('forest')).toBe('#ffffff');
  });
});
