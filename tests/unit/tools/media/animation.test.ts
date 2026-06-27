/**
 * Guards normalizeFramesArg + buildFrameHtml behind media.animation. The frame
 * coercion (the LLM may stringify the nested array) and the pure frame card are
 * checked here; the chromium + ffmpeg GIF assembly is exercised by live e2e.
 */
import { describe, it, expect } from 'vitest';
import { normalizeFramesArg, buildFrameHtml } from '../../../../src/core/tools/builtin/media/tools/animation.js';

describe('normalizeFramesArg', () => {
  it('passes a real array of objects through', () => {
    expect(normalizeFramesArg([{ text: 'A', subtitle: 'x' }, { text: 'B' }])).toEqual([
      { text: 'A', subtitle: 'x' }, { text: 'B' },
    ]);
  });

  it('parses a JSON STRING of the array (the failure mode nested-arg tools hit)', () => {
    expect(normalizeFramesArg('[{"text":"A"},{"text":"B"}]')).toEqual([{ text: 'A' }, { text: 'B' }]);
  });

  it('accepts plain-string frames and the title alias', () => {
    expect(normalizeFramesArg(['hello', 'world'])).toEqual([{ text: 'hello' }, { text: 'world' }]);
    expect(normalizeFramesArg([{ title: 'Heading' }])).toEqual([{ text: 'Heading' }]);
  });

  it('drops empty/garbage entries; non-array → []', () => {
    expect(normalizeFramesArg([{ subtitle: 'no text' }, '   ', { text: 'keep' }])).toEqual([{ text: 'keep' }]);
    expect(normalizeFramesArg('not json')).toEqual([]);
    expect(normalizeFramesArg(7)).toEqual([]);
  });
});

describe('buildFrameHtml', () => {
  it('renders the caption, subtitle and one progress dot per frame', () => {
    const html = buildFrameHtml({ text: 'Step 1', subtitle: 'do this' }, 0, 3);
    expect(html).toContain('Step 1');
    expect(html).toContain('do this');
    expect((html.match(/class="dot(?:"| on")/g) || []).length).toBe(3); // one dot per frame (not the .dots container)
    expect(html).toContain('class="dot on"'); // the active frame's dot
  });

  it('omits the subtitle line when absent and escapes text', () => {
    const html = buildFrameHtml({ text: '<b>&' }, 1, 2);
    expect(html).not.toContain('class="sub"');
    expect(html).toContain('&lt;b&gt;&amp;');
    // active dot is the 2nd one → exactly one ".dot on"
    expect((html.match(/class="dot on"/g) || []).length).toBe(1);
  });
});
