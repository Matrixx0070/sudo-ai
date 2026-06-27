/**
 * Guards buildSlidesHtml — the pure deck builder behind document.slides. One
 * page-breaking section per slide (+ a title slide when a deck title is given),
 * bullets capped, user text escaped — all without a browser.
 */
import { describe, it, expect } from 'vitest';
import { buildSlidesHtml, normalizeSlidesArg } from '../../../../src/core/tools/builtin/document/tools/slides.js';

describe('buildSlidesHtml', () => {
  it('emits a title slide + one section per content slide', () => {
    const html = buildSlidesHtml([{ title: 'Intro', bullets: ['a', 'b'] }, { title: 'Body' }], 'My Deck', 'a subtitle');
    expect((html.match(/class="slide/g) || []).length).toBe(3); // title + 2 content
    expect(html).toContain('title-slide');
    expect(html).toContain('My Deck');
    expect(html).toContain('a subtitle');
    expect(html).toContain('Intro');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('Body');
    expect(html).toContain('page-break-after');
  });

  it('omits the title slide when no deck title is given', () => {
    const html = buildSlidesHtml([{ title: 'Only' }]);
    // The .title-slide CSS class is always defined; assert no title-slide SECTION.
    expect(html).not.toContain('class="slide title-slide"');
    expect((html.match(/class="slide"/g) || []).length).toBe(1); // exact content-slide class
  });

  it('caps bullets at 8 per slide', () => {
    const html = buildSlidesHtml([{ title: 'T', bullets: Array.from({ length: 20 }, (_, i) => `b${i}`) }]);
    expect((html.match(/<li>/g) || []).length).toBe(8);
  });

  it('escapes slide titles, bullets and the deck title', () => {
    const html = buildSlidesHtml([{ title: '<x>', bullets: ['a & b'] }], '"Deck"');
    expect(html).not.toContain('<x>');
    expect(html).toContain('&lt;x&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });
});

describe('normalizeSlidesArg (LLM arg coercion — the live bug)', () => {
  it('passes a real array through', () => {
    expect(normalizeSlidesArg([{ title: 'A', bullets: ['x'] }])).toEqual([{ title: 'A', bullets: ['x'] }]);
  });

  it('parses a JSON STRING of the array (the failure mode the agent hit)', () => {
    const out = normalizeSlidesArg('[{"title":"A","bullets":["x","y"]}]');
    expect(out).toEqual([{ title: 'A', bullets: ['x', 'y'] }]);
  });

  it('coerces per-slide bullets from a JSON string or newline string', () => {
    expect(normalizeSlidesArg([{ title: 'A', bullets: '["x","y"]' }])[0]!.bullets).toEqual(['x', 'y']);
    expect(normalizeSlidesArg([{ title: 'B', bullets: 'one\ntwo' }])[0]!.bullets).toEqual(['one', 'two']);
  });

  it('skips entries without a title; empty/garbage → []', () => {
    expect(normalizeSlidesArg([{ bullets: ['x'] }, { title: 'Keep' }])).toEqual([{ title: 'Keep', bullets: [] }]);
    expect(normalizeSlidesArg('not json')).toEqual([]);
    expect(normalizeSlidesArg(42)).toEqual([]);
  });
});
