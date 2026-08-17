/**
 * ActivityTimeline — the live agent working card edited in place by chat
 * surfaces (Telegram stream-sink status). Default render is the compact
 * assistant card (pulse glyph + bold semantic headline + elapsed·step meta,
 * Mira-benchmark layout); `detail: true` renders the full ✓/✗ step timeline.
 * Pure state + formatting throughout.
 */
import { describe, it, expect } from 'vitest';
import { ActivityTimeline } from '../../../src/core/channels/activity-timeline.js';
import type { ProgressEvent } from '../../../src/core/gateway/progress.js';

const T0 = 1_000_000;

function ev(partial: Partial<ProgressEvent> & { type: ProgressEvent['type'] }): ProgressEvent {
  return { sessionId: 's', message: '', timestamp: T0, ...partial };
}

describe('ActivityTimeline compact card (default)', () => {
  it('starts as a bold Thinking headline with a 💭 activity emoji and elapsed meta', () => {
    const tl = new ActivityTimeline();
    const text = tl.render({ nowMs: T0, startMs: T0, tick: 0 });
    expect(text).toBe('💭 **Thinking**\n\n0s');
  });

  it('rotates thinking headlines during long silences', () => {
    const tl = new ActivityTimeline();
    const later = tl.render({ nowMs: T0 + 9000, startMs: T0, tick: 3 });
    expect(later).toContain('**Reflecting on context**');
  });

  it('maps an in-flight tool to a semantic headline + breadcrumb meta', () => {
    const tl = new ActivityTimeline();
    tl.onProgress(ev({ type: 'tool_call', tool: 'web.search' }), T0);
    const text = tl.render({ nowMs: T0 + 12_000, startMs: T0, tick: 2 });
    expect(text).toContain('**Searching the web**');
    expect(text).toContain('12s · web › search…');
    expect(text).not.toContain('web.search'); // dotted form would linkify
  });

  it('shows a done-step count between tools and Writing the reply while streaming', () => {
    const tl = new ActivityTimeline();
    tl.onProgress(ev({ type: 'tool_call', tool: 'web.search' }), T0);
    tl.onProgress(ev({ type: 'tool_result', tool: 'web.search', ok: true }), T0 + 2000);
    let text = tl.render({ nowMs: T0 + 4000, startMs: T0, tick: 0 });
    expect(text).toContain('4s · 1 step done');

    tl.onProgress(ev({ type: 'streaming' }), T0 + 5000);
    text = tl.render({ nowMs: T0 + 5000, startMs: T0, tick: 0 });
    expect(text).toContain('**Writing the reply**');
  });

  it('formats elapsed past a minute as Nm SSs', () => {
    const tl = new ActivityTimeline();
    expect(tl.render({ nowMs: T0 + 65_000, startMs: T0, tick: 0 })).toContain('1m 05s');
  });

  it('the activity emoji reflects WHAT it is doing (thinking vs a tool)', () => {
    const tl = new ActivityTimeline();
    // Thinking phase → 💭
    expect(tl.render({ nowMs: T0, startMs: T0, tick: 0 }).startsWith('💭')).toBe(true);
    // A web tool → the searching glyph 🔍
    tl.onProgress(ev({ type: 'tool_call', tool: 'web.search' }), T0);
    expect(tl.render({ nowMs: T0 + 1000, startMs: T0, tick: 0 }).startsWith('🔍')).toBe(true);
    // Streaming the answer → the writing glyph ✍️
    tl.onProgress(ev({ type: 'tool_result', tool: 'web.search', ok: true }), T0 + 2000);
    tl.onProgress(ev({ type: 'streaming' }), T0 + 3000);
    expect(tl.render({ nowMs: T0 + 3000, startMs: T0, tick: 0 }).startsWith('✍️')).toBe(true);
  });

  it('appends the chip line only when provided', () => {
    const tl = new ActivityTimeline();
    expect(tl.render({ nowMs: T0, startMs: T0, tick: 0, chip: 'fable-5 | 2%' })).toContain('fable-5 | 2%');
    expect(tl.render({ nowMs: T0, startMs: T0, tick: 0 })).not.toContain('fable-5');
  });
});

describe('ActivityTimeline detail mode', () => {
  const opts = { detail: true } as const;

  it('renders the full step list with ✓/✗ and durations', () => {
    const tl = new ActivityTimeline();
    tl.onProgress(ev({ type: 'tool_call', tool: 'web.search' }), T0);
    let text = tl.render({ nowMs: T0 + 4000, startMs: T0, tick: 1, ...opts });
    expect(text).toContain('▸ web › search… 4s');

    tl.onProgress(ev({ type: 'tool_result', tool: 'web.search', ok: true }), T0 + 5000);
    tl.onProgress(ev({ type: 'tool_call', tool: 'browser.open' }), T0 + 5000);
    tl.onProgress(ev({ type: 'tool_result', tool: 'browser.open', ok: false }), T0 + 5500);
    text = tl.render({ nowMs: T0 + 5500, startMs: T0, tick: 2, ...opts });
    expect(text).toContain('✓ web › search · 5s');
    expect(text).toContain('✗ browser › open');
  });

  it('collapses older steps beyond the visible window into "+N earlier"', () => {
    const tl = new ActivityTimeline();
    for (let i = 0; i < 9; i++) {
      tl.onProgress(ev({ type: 'tool_call', tool: `tool${i}` }), T0 + i);
      tl.onProgress(ev({ type: 'tool_result', tool: `tool${i}`, ok: true }), T0 + i);
    }
    const text = tl.render({ nowMs: T0 + 100, startMs: T0, tick: 0, ...opts });
    expect(text).toContain('… +3 earlier steps');
    expect(text).not.toContain('tool0');
    expect(text).toContain('tool8');
  });

  it('never renders past the char cap and never throws on junk events', () => {
    const tl = new ActivityTimeline();
    for (let i = 0; i < 500; i++) {
      tl.onProgress(ev({ type: 'tool_call', tool: `x`.repeat(200) }), T0);
    }
    tl.onProgress(null as unknown as ProgressEvent, T0);
    tl.onProgress(ev({ type: 'tool_result' }), T0);
    const text = tl.render({ nowMs: T0, startMs: T0, tick: 0, ...opts });
    expect(text.length).toBeLessThanOrEqual(3000);
  });
});

describe('renderFinal', () => {
  it('collapses to a done summary with step + failure counts', () => {
    const tl = new ActivityTimeline();
    tl.onProgress(ev({ type: 'tool_call', tool: 'a' }), T0);
    tl.onProgress(ev({ type: 'tool_result', tool: 'a', ok: true }), T0 + 1000);
    tl.onProgress(ev({ type: 'tool_call', tool: 'b' }), T0 + 1000);
    tl.onProgress(ev({ type: 'tool_result', tool: 'b', ok: false }), T0 + 2000);
    expect(tl.renderFinal({ nowMs: T0 + 14_000, startMs: T0 })).toBe('✅ Done • 14s • 2 steps (1 failed)');

    tl.onProgress(ev({ type: 'error' }), T0 + 14_000);
    expect(tl.renderFinal({ nowMs: T0 + 14_000, startMs: T0 })).toContain('⚠️ Finished with errors');
  });
});
