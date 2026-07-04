/**
 * P0 #4 — compaction must not erase the live conversation.
 *
 * Before this, runCompaction replaced the ENTIRE history with one summary
 * system message, so the in-flight user ask survived only as summary prose; an
 * incomplete summary (accepted on the final retry) could drop it. Now the last
 * K non-system messages are kept verbatim alongside the summary, and the most
 * recent user message is always retained.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runCompaction,
  selectVerbatimTail,
  type BrainLike,
  type BrainRequest,
  type BrainResponse,
  type BrainMessage,
  type SessionLike,
} from '../../src/core/agent/loop-helpers.js';
import type { AgentState } from '../../src/core/agent/types.js';

const VALID_SUMMARY = [
  '- Decisions: shipped X',
  '- Open TODOs: finish Y',
  '- Constraints: keep Z',
  '- Pending asks: user is waiting on the deploy',
  '- Identifiers: repo/main',
].join('\n');

function makeState(): AgentState {
  return {
    sessionId: 'test-session', iteration: 0, isProcessing: false, isCompacting: false,
    pendingToolCalls: 0, followUpMessages: [], consecutiveReplans: 0,
  } as AgentState;
}

class StubBrain implements BrainLike {
  constructor(private readonly reply: BrainResponse | Error) {}
  async call(_req: BrainRequest): Promise<BrainResponse> {
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

function session(messages: BrainMessage[]): SessionLike {
  return { id: 'test-session', messages } as SessionLike;
}

const noopEmit = () => {};

describe('selectVerbatimTail', () => {
  it('keeps the last k non-system messages', () => {
    const msgs: BrainMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ];
    const tail = selectVerbatimTail(msgs, 2);
    expect(tail.map((m) => m.content)).toEqual(['u2', 'a2']);
  });

  it('never starts the tail on an orphan tool result', () => {
    const msgs: BrainMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1', toolCalls: [{ id: '1', name: 't', arguments: {} }] },
      { role: 'tool', content: 'result', toolCallId: '1' },
      { role: 'assistant', content: 'a2' },
    ];
    // k=2 slices ['tool','assistant'] → leading orphan tool dropped, then the
    // user-retention invariant prepends the sole user message.
    const tail = selectVerbatimTail(msgs, 2);
    expect(tail[0]!.role).not.toBe('tool');
    expect(tail.some((m) => m.role === 'tool')).toBe(false);
    expect(tail.map((m) => m.content)).toEqual(['u1', 'a2']);
  });

  it('always retains the most recent user message even when orphan-trimmed', () => {
    const msgs: BrainMessage[] = [
      { role: 'user', content: 'the ask' },
      { role: 'assistant', content: 'a1', toolCalls: [{ id: '1', name: 't', arguments: {} }] },
      { role: 'tool', content: 'r1', toolCallId: '1' },
      { role: 'tool', content: 'r2', toolCallId: '2' },
    ];
    // k=2 → ['tool','tool'] → both orphan-dropped → empty → user re-prepended.
    const tail = selectVerbatimTail(msgs, 2);
    expect(tail.some((m) => m.role === 'user' && m.content === 'the ask')).toBe(true);
  });

  it('handles degenerate inputs without error', () => {
    // k larger than the message count → return all non-system.
    expect(selectVerbatimTail([{ role: 'user', content: 'u' }], 50).map((m) => m.content)).toEqual(['u']);
    // Empty input.
    expect(selectVerbatimTail([], 6)).toEqual([]);
    // All-system → no non-system to keep, no user to re-prepend.
    expect(selectVerbatimTail([{ role: 'system', content: 's' }], 6)).toEqual([]);
    // No user message → whatever non-system tail (assistant only), no prepend.
    expect(
      selectVerbatimTail([{ role: 'assistant', content: 'a' }], 6).map((m) => m.content),
    ).toEqual(['a']);
  });
});

describe('runCompaction verbatim-tail preservation (P0 #4)', () => {
  beforeEach(() => { delete process.env['SUDO_COMPACT_PRESERVE_TAIL']; });
  afterEach(() => { delete process.env['SUDO_COMPACT_PRESERVE_TAIL']; delete process.env['SUDO_COMPACT_TAIL_COUNT']; });

  const history = (): BrainMessage[] => [
    { role: 'system', content: 'seed' },
    { role: 'user', content: 'old ask' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'IN-FLIGHT ASK' },
    { role: 'assistant', content: 'partial answer' },
  ];

  it('keeps the summary AND the in-flight ask verbatim', async () => {
    const sess = session(history());
    await runCompaction(new StubBrain({ content: VALID_SUMMARY } as BrainResponse), sess, makeState(), noopEmit);
    expect(sess.messages[0]!.role).toBe('system');
    expect(sess.messages[0]!.content).toContain('[Context compacted]');
    // The actual user ask survives verbatim, not just as summary prose.
    expect(sess.messages.some((m) => m.role === 'user' && m.content === 'IN-FLIGHT ASK')).toBe(true);
    expect(sess.messages.length).toBeGreaterThan(1);
  });

  it('legacy summary-only replace when SUDO_COMPACT_PRESERVE_TAIL=0', async () => {
    process.env['SUDO_COMPACT_PRESERVE_TAIL'] = '0';
    const sess = session(history());
    await runCompaction(new StubBrain({ content: VALID_SUMMARY } as BrainResponse), sess, makeState(), noopEmit);
    expect(sess.messages).toHaveLength(1);
    expect(sess.messages[0]!.role).toBe('system');
  });

  it('leaves the conversation intact when compaction throws (no data loss)', async () => {
    const original = history();
    const sess = session([...original]);
    const summary = await runCompaction(new StubBrain(new Error('brain down')), sess, makeState(), noopEmit);
    expect(summary).toBe('');
    // On failure the conversation is preserved rather than erased. (A benign
    // pre-compaction flush reminder may be appended, so we assert every
    // original message survives rather than an exact length.)
    for (const m of original) {
      expect(sess.messages.some((x) => x.role === m.role && x.content === m.content)).toBe(true);
    }
    expect(sess.messages.some((m) => m.content === 'IN-FLIGHT ASK')).toBe(true);
  });
});

// A brain whose call() never resolves — to exercise the summariser safety timeout.
class HangingBrain implements BrainLike {
  async call(_req: BrainRequest): Promise<BrainResponse> {
    return new Promise<BrainResponse>(() => { /* never resolves */ });
  }
}
// A brain that must never be called — to prove the skip guard short-circuits.
class ThrowIfCalledBrain implements BrainLike {
  async call(_req: BrainRequest): Promise<BrainResponse> {
    throw new Error('brain.call must not be reached');
  }
}

describe('runCompaction summariser bounds', () => {
  afterEach(() => { delete process.env['SUDO_COMPACTION_TIMEOUT_MS']; });

  it('skip guard: no brain call and history untouched when there is no real conversation', async () => {
    const sess = session([
      { role: 'system', content: 'seed header' },
      { role: 'system', content: '[intelligence brief] nothing real here' },
    ]);
    const before = sess.messages.map((m) => ({ ...m }));
    const summary = await runCompaction(new ThrowIfCalledBrain(), sess, makeState(), noopEmit);
    expect(summary).toBe('');
    expect(sess.messages).toEqual(before); // untouched — no flush, no summary, no call
  });

  it('safety timeout: degrades to no-compaction (history preserved) when the summariser hangs', async () => {
    process.env['SUDO_COMPACTION_TIMEOUT_MS'] = '50';
    const original: BrainMessage[] = [
      { role: 'system', content: 'seed' },
      { role: 'user', content: 'IN-FLIGHT ASK' },
      { role: 'assistant', content: 'partial answer' },
    ];
    const sess = session([...original]);
    const summary = await runCompaction(new HangingBrain(), sess, makeState(), noopEmit);
    expect(summary).toBe('');
    for (const m of original) {
      expect(sess.messages.some((x) => x.role === m.role && x.content === m.content)).toBe(true);
    }
  });
});
