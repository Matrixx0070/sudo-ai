/**
 * Guards highlightCode + buildCodeImageHtml — the Node-side highlighter and the
 * pure card builder behind media.code-image. No browser: the screenshot step is
 * exercised by live e2e, the structure/escaping/gutter here.
 */
import { describe, it, expect } from 'vitest';
import { highlightCode, buildCodeImageHtml } from '../../../../src/core/tools/builtin/media/tools/code-image.js';

describe('highlightCode', () => {
  it('uses the given language and wraps tokens in hljs spans', () => {
    const { html, language } = highlightCode('const x = 1;', 'javascript');
    expect(language).toBe('javascript');
    expect(html).toContain('hljs-keyword'); // `const`
    expect(html).toContain('const');
  });

  it('auto-detects when language is omitted or unknown', () => {
    const { language } = highlightCode('def add(a, b):\n    return a + b', 'not-a-real-lang');
    expect(typeof language).toBe('string');
    expect(language.length).toBeGreaterThan(0);
  });

  it('HTML-escapes code so it cannot inject markup', () => {
    const { html } = highlightCode('const s = "<script>alert(1)</script>";', 'javascript');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('buildCodeImageHtml', () => {
  const base = { highlighted: '<span class="hljs-keyword">const</span> x', lineCount: 3, language: 'javascript' };

  it('emits one gutter number per line and embeds the highlighted markup', () => {
    const html = buildCodeImageHtml(base);
    expect(html).toContain('<span>1</span>');
    expect(html).toContain('<span>2</span>');
    expect(html).toContain('<span>3</span>');
    expect(html).not.toContain('<span>4</span>');
    expect(html).toContain('<span class="hljs-keyword">const</span> x');
  });

  it('shows the title in the window bar when given, else the language', () => {
    expect(buildCodeImageHtml({ ...base, title: 'app.ts' })).toContain('>app.ts<');
    expect(buildCodeImageHtml(base)).toContain('>javascript<');
  });

  it('escapes the title', () => {
    expect(buildCodeImageHtml({ ...base, title: '<x>' })).toContain('&lt;x&gt;');
  });

  it('applies a different background per theme and has the window chrome dots', () => {
    const dark = buildCodeImageHtml({ ...base, theme: 'dark' });
    const light = buildCodeImageHtml({ ...base, theme: 'light' });
    expect(dark).toContain('#1e1e2e'); // dark card bg
    expect(light).toContain('#ffffff'); // light card bg
    expect(dark).toContain('class="dot red"');
    expect(dark).toContain('class="dot green"');
  });
});
