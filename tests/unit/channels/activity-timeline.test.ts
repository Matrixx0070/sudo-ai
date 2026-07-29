/**
 * ActivityTimeline — the compact live agent-activity card edited in place by
 * chat surfaces (Telegram stream-sink status). Pure state + formatting: proves
 * step tracking (call → result matching, failures), phase labels, the ` › `
 * tool-name breadcrumb (dots would be auto-linkified by Telegram), the tail
 * window + "+N earlier" collapse, char caps, and the final summary.
 */
import { describe, it, expect } from 'vitest';
import { ActivityTimeline } from '../../../src/core/channels/activity-timeline.js';
import type { ProgressEvent } from '../../../src/core/gateway/progress.js';

const T0 = 1_000_000;

function ev(partial: Partial<ProgressEvent> & { type: ProgressEvent['type'] }): ProgressEvent {
  return { sessionId: 's', message: '', timestamp: T0, ...partial };
}

describe('ActivityTimeline', () => {
  it('starts as a Thinking card with pulse glyph + elapsed and no steps', () => {
    const tl = new ActivityTimeline();
    const text = tl.render({ nowMs: T0, startMs: T0, tick: 0 });
    expect(text).toContain('Thinking… 0s');
    expect(text.startsWith('✢')).toBe(true);
    expect(tl.hasActivity).toBe(false);
  });

  it('tracks a tool call as in-flight with a breadcrumb name, then closes it with ✓', () => {
    const tl = new ActivityTimeline();
    tl.onProgress(ev({ type: 'tool_call', tool: 'web.search' }), T0);
    let text = tl.render({ nowMs: T0 + 4000, startMs: T0, tick: 1 });
    expect(text).toContain('▸ web › search… 4s');
    expect(text).toContain('Working…');
    expect(text).not.toContain('web.search'); // dotted form would linkify

    tl.onProgress(ev({ type: 'tool_result', tool: 'web.search', ok: true }), T0 + 5000);
    text = tl.render({ nowMs: T0 + 5000, startMs: T0, tick: 2 });
    expect(text).toContain('✓ web › search · 5s');
    expect(text).not.toContain('▸');
  });

  it('marks failed steps with ✗', () => {
    const tl = new ActivityTimeline();
    tl.onProgress(ev({ type: 'tool_call', tool: 'browser.open' }), T0);
    tl.onProgress(ev({ type: 'tool_result', tool: 'browser.open', ok: false }), T0 + 500);
    const text = tl.render({ nowMs: T0 + 500, startMs: T0, tick: 0 });
    expect(text).toContain('✗ browser › open');
  });

  it('shows a chip line when provided and the Writing phase while streaming', () => {
    const tl = new ActivityTimeline();
    tl.onProgress(ev({ type: 'streaming' }), T0);
    const text = tl.render({ nowMs: T0, startMs: T0, tick: 0, chip: 'fable-5 | 21k/1.0m (2%)' });
    expect(text).toContain('Writing…');
    expect(text).toContain('fable-5 | 21k/1.0m (2%)');
    expect(tl.render({ nowMs: T0, startMs: T0, tick: 0 })).not.toContain('fable-5');
  });

  it('formats elapsed past a minute as Nm SSs', () => {
    const tl = new ActivityTimeline();
    const text = tl.render({ nowMs: T0 + 65_000, startMs: T0, tick: 0 });
    expect(text).toContain('Thinking… 1m 05s');
  });

  it('collapses older steps beyond the visible window into "+N earlier"', () => {
    const tl = new ActivityTimeline();
    for (let i = 0; i < 9; i++) {
      tl.onProgress(ev({ type: 'tool_call', tool: `tool${i}` }), T0 + i);
      tl.onProgress(ev({ type: 'tool_result', tool: `tool${i}`, ok: true }), T0 + i);
    }
    const text = tl.render({ nowMs: T0 + 100, startMs: T0, tick: 0 });
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
    tl.onProgress(ev({ type: 'tool_result' }), T0); // no tool name — closes newest open step
    const text = tl.render({ nowMs: T0, startMs: T0, tick: 0 });
    expect(text.length).toBeLessThanOrEqual(3000);
  });

  it('renderFinal collapses to a done summary with step + failure counts', () => {
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
