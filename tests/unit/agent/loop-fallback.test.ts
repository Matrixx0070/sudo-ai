/**
 * Unit tests for buildLoopFallbackReply — the streak-aware text used when
 * the AgentLoop cross-iteration LoopGuard fires AND the model produced no
 * text content.
 *
 * Closes the WEAKEST POINT from the 2026-06-16 audit: prior fallback was a
 * byte-identical canned string on every consecutive loop, giving the user
 * no signal that the bot was stuck in a sustained loop. Streak count makes
 * the user-visible reply differ turn-over-turn.
 */

import { describe, it, expect } from 'vitest';
import {
  buildLoopFallbackReply,
  extractLoopStreak,
  LOOP_FALLBACK_FIRST_HIT,
} from '../../../src/core/agent/loop-fallback.js';
import type { BrainMessage } from '../../../src/core/brain/types.js';

function msg(role: BrainMessage['role'], content: string): BrainMessage {
  return { role, content };
}

describe('buildLoopFallbackReply', () => {
  it('returns the first-hit text when there is no prior assistant message', () => {
    expect(buildLoopFallbackReply([])).toBe(LOOP_FALLBACK_FIRST_HIT);
    expect(
      buildLoopFallbackReply([msg('user', 'hi'), msg('system', 'whatever')]),
    ).toBe(LOOP_FALLBACK_FIRST_HIT);
  });

  it('returns the first-hit text when the prior assistant message is unrelated', () => {
    expect(
      buildLoopFallbackReply([
        msg('user', 'q1'),
        msg('assistant', 'Here is a real answer about widgets.'),
        msg('user', 'q2'),
      ]),
    ).toBe(LOOP_FALLBACK_FIRST_HIT);
  });

  it('bumps to streak=2 when the prior assistant message is the canned first hit', () => {
    const reply = buildLoopFallbackReply([
      msg('user', 'q1'),
      msg('assistant', LOOP_FALLBACK_FIRST_HIT),
      msg('user', 'q2'),
    ]);
    expect(reply).toContain('(2× in a row)');
    expect(reply).not.toBe(LOOP_FALLBACK_FIRST_HIT);
    expect(reply).toContain('/reset');
  });

  it('bumps the streak counter when the prior assistant message is itself a streak message', () => {
    const previousStreak = `I'm stuck in the same tool-loop (2× in a row). The same tools keep firing without progress — try /reset, or rephrase your question. Retrying the same prompt will keep hitting this loop.`;
    const reply = buildLoopFallbackReply([
      msg('user', 'q1'),
      msg('assistant', LOOP_FALLBACK_FIRST_HIT),
      msg('user', 'q2'),
      msg('assistant', previousStreak),
      msg('user', 'q3'),
    ]);
    expect(reply).toContain('(3× in a row)');
  });

  it('looks at the MOST RECENT assistant message, not earlier ones', () => {
    const reply = buildLoopFallbackReply([
      msg('user', 'q1'),
      msg('assistant', LOOP_FALLBACK_FIRST_HIT),
      msg('user', 'q2'),
      msg('assistant', 'A genuine helpful reply unrelated to looping.'),
      msg('user', 'q3'),
    ]);
    // The most recent assistant is a real reply, so this is treated as a
    // fresh first hit even though an earlier fallback existed.
    expect(reply).toBe(LOOP_FALLBACK_FIRST_HIT);
  });

  it('ignores tool / user / system messages between assistant turns', () => {
    const reply = buildLoopFallbackReply([
      msg('assistant', LOOP_FALLBACK_FIRST_HIT),
      msg('user', 'q2'),
      msg('system', '[trim] context cropped'),
      msg('tool' as BrainMessage['role'], 'tool result'),
    ]);
    expect(reply).toContain('(2× in a row)');
  });

  it('skips assistant messages with empty content (e.g. mid-stream)', () => {
    const reply = buildLoopFallbackReply([
      msg('assistant', LOOP_FALLBACK_FIRST_HIT),
      msg('user', 'q2'),
      msg('assistant', ''),
    ]);
    expect(reply).toContain('(2× in a row)');
  });
});

describe('extractLoopStreak', () => {
  it('returns 1 for unparseable text (safe default — next bump is 2)', () => {
    expect(extractLoopStreak('totally unrelated text')).toBe(1);
    expect(extractLoopStreak(LOOP_FALLBACK_FIRST_HIT)).toBe(1);
  });

  it('extracts a multi-digit streak number', () => {
    const streak = `I'm stuck in the same tool-loop (12× in a row). foo.`;
    expect(extractLoopStreak(streak)).toBe(12);
  });

  it('falls back to 1 when the parsed number is zero or negative', () => {
    expect(extractLoopStreak('something (0× in a row)')).toBe(1);
  });
});
