/**
 * Guards renderMathToHtml + buildMathHtml behind media.math. The KaTeX render and
 * the self-contained card (with base64-embedded fonts) are checked here; the
 * chromium screenshot is exercised by live e2e.
 */
import { describe, it, expect } from 'vitest';
import { renderMathToHtml, buildMathHtml } from '../../../../src/core/tools/builtin/media/tools/math.js';

describe('renderMathToHtml', () => {
  it('renders valid LaTeX into KaTeX markup', () => {
    const html = renderMathToHtml('\\frac{1}{2}');
    expect(html).toContain('katex');
    expect(html).toContain('frac');
  });

  it('honours displayMode', () => {
    expect(renderMathToHtml('x^2', true)).toContain('katex-display');
    expect(renderMathToHtml('x^2', false)).not.toContain('katex-display');
  });

  it('does not throw on invalid LaTeX (renders an error instead)', () => {
    expect(() => renderMathToHtml('\\frac{')).not.toThrow();
    const html = renderMathToHtml('\\frac{');
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });
});

describe('buildMathHtml', () => {
  const math = renderMathToHtml('a^2 + b^2 = c^2');

  it('embeds the rendered math and self-contained (base64) fonts', () => {
    const html = buildMathHtml({ mathHtml: math });
    expect(html).toContain('a'); // the rendered equation is present
    expect(html).toContain('data:font/woff2;base64,'); // fonts inlined → no network needed
    expect(html).toContain('id="shot"');
  });

  it('applies a different card background per theme', () => {
    expect(buildMathHtml({ mathHtml: math, theme: 'light' })).toContain('#ffffff');
    expect(buildMathHtml({ mathHtml: math, theme: 'dark' })).toContain('#0f172a');
  });
});
