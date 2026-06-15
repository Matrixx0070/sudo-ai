/**
 * Two-tier compaction TIER 2/3 escalation (gap #14 deferred follow-up).
 *
 * Wires the latent `autoCompact`/`fullCompact` paths in compaction.ts as
 * successor tiers below LAYER 1's brain-driven `compact()`. Drives the
 * `escalateCompaction` helper end-to-end through the four success/fallback
 * paths the contract specifies.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { escalateCompaction, type BrainLike, type BrainRequest, type BrainResponse } from '../../src/core/agent/loop-helpers.js';
import { resetAutoCompactFailures } from '../../src/core/agent/compaction.js';
import type { AgentState } from '../../src/core/agent/types.js';

function makeState(): AgentState {
  return {
    sessionId: 'test-session',
    iteration: 0,
    isProcessing: false,
    isCompacting: false,
    pendingToolCalls: 0,
    followUpMessages: [],
    consecutiveReplans: 0,
  } as AgentState;
}

interface MutableSession {
  id: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>;
}

/**
 * Build a history whose total char count crosses BOTH thresholds we care about:
 *   - shouldCompact:      tokens >= 48_000  → chars >= ~192_000
 *   - autoCompact active: tokens > 47_000   → chars > ~188_000
 * Eight messages so head(2) + tail(6) leaves zero middle in autoCompact's
 * own slice math; we counter that with extra middle messages so the brain
 * receives a non-empty `middle` block.
 */
function makeFatHistory(): MutableSession['messages'] {
  const fat = 'X'.repeat(50_000);
  return [
    { role: 'system', content: 'system seed' },
    { role: 'user', content: 'initial ask' },
    { role: 'assistant', content: fat }, // middle 1
    { role: 'tool', content: fat },      // middle 2
    { role: 'assistant', content: fat }, // middle 3
    { role: 'tool', content: fat },      // middle 4
    { role: 'user', content: 'next ask' },
    { role: 'assistant', content: fat }, // middle 5
    { role: 'user', content: 'follow-up' },
    { role: 'assistant', content: 'short' },
  ];
  // 5 fat × 50_000 = 250_000 chars ≈ 62_500 tokens > 48_000 shouldCompact threshold.
}

class RecordingBrain implements BrainLike {
  calls: Array<{ messageCount: number; firstUserSnippet: string }> = [];
  responses: Array<BrainResponse | Error> = [];

  queueResponse(r: BrainResponse | Error): void {
    this.responses.push(r);
  }

  async call(req: BrainRequest): Promise<BrainResponse> {
    const firstUser = req.messages.find((m) => m.role === 'user');
    this.calls.push({
      messageCount: req.messages.length,
      firstUserSnippet: (firstUser?.content ?? '').slice(0, 80),
    });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('RecordingBrain: no response queued');
    return next;
  }
}

function okResponse(content: string): BrainResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    model: 'stub',
  };
}

describe('escalateCompaction (gap #14 TIER 2/3)', () => {
  beforeEach(() => {
    resetAutoCompactFailures();
  });

  it('is a no-op when history is below the shouldCompact threshold', async () => {
    const brain = new RecordingBrain();
    const session: MutableSession = {
      id: 't',
      messages: [
        { role: 'user', content: 'tiny' },
        { role: 'assistant', content: 'reply' },
      ],
    };
    const before = JSON.stringify(session.messages);

    await escalateCompaction(brain, session as never, makeState());

    expect(brain.calls).toHaveLength(0);
    expect(JSON.stringify(session.messages)).toBe(before);
  });

  it('TIER 2 path: autoCompact succeeds, fullCompact is skipped', async () => {
    const brain = new RecordingBrain();
    // autoCompact summary tiny enough to drop the post-collapse history
    // below the shouldCompact threshold so TIER 3 stays dormant.
    brain.queueResponse(okResponse('short summary'));

    const session: MutableSession = { id: 't', messages: makeFatHistory() };
    const before = session.messages.length;

    await escalateCompaction(brain, session as never, makeState());

    expect(brain.calls).toHaveLength(1);
    // autoCompact replaces the middle with a single system summary marker.
    const systems = session.messages.filter((m) => m.role === 'system');
    expect(systems.some((m) => m.content.includes('[AutoCompact summary]'))).toBe(true);
    expect(session.messages.length).toBeLessThan(before);
    expect(session.messages.some((m) => m.content.includes('[FullCompact'))).toBe(false);
  });

  it('TIER 3 path: autoCompact returns no-op → fullCompact takes over', async () => {
    const brain = new RecordingBrain();
    // Brain throws on the autoCompact call — autoCompact catches and returns
    // compacted:false, so the post-TIER-2 shouldCompact check stays true and
    // escalation continues into TIER 3.
    brain.queueResponse(new Error('boom — autoCompact brain fail'));
    // fullCompact then runs and produces a small summary.
    brain.queueResponse(okResponse('dense nuclear summary'));

    const session: MutableSession = { id: 't', messages: makeFatHistory() };

    await escalateCompaction(brain, session as never, makeState());

    expect(brain.calls).toHaveLength(2);
    // fullCompact collapses to [system: FullCompact summary, lastUser]
    expect(session.messages.length).toBeLessThanOrEqual(2);
    expect(session.messages[0]?.role).toBe('system');
    expect(session.messages[0]?.content).toContain('[FullCompact');
    expect(session.messages[0]?.content).toContain('dense nuclear summary');
    // Last user turn preserved (fullCompact contract).
    expect(session.messages.at(-1)?.role).toBe('user');
  });

  it('per-session circuit breaker: session A tripped → session B unaffected', async () => {
    // 3 throw-everything escalateCompaction calls on session A pushes its
    // autoCompact counter to the maxFailures=3 limit; the 4th call must
    // short-circuit autoCompact (no brain call for TIER 2). Session B,
    // starting fresh, must still hit autoCompact and succeed.
    const throwBrain = new RecordingBrain();
    for (let i = 0; i < 6; i++) throwBrain.queueResponse(new Error('down'));

    const sessionA: MutableSession = { id: 'A', messages: makeFatHistory() };
    const stateA = makeState();

    // Trip the breaker on session A (3 turns, each: autoCompact throws then
    // fullCompact throws → 2 brain calls per turn → 6 total).
    for (let i = 0; i < 3; i++) {
      sessionA.messages = makeFatHistory(); // restore fat each turn
      await escalateCompaction(throwBrain, sessionA as never, stateA);
    }
    expect(throwBrain.calls).toHaveLength(6);

    // Now use a healthy brain on session A — autoCompact is circuit-broken,
    // so only fullCompact runs (one brain call).
    const healthyA = new RecordingBrain();
    healthyA.queueResponse(okResponse('A nuclear summary'));
    sessionA.messages = makeFatHistory();
    await escalateCompaction(healthyA, sessionA as never, stateA);
    expect(healthyA.calls).toHaveLength(1);
    expect(sessionA.messages[0]?.content).toContain('[FullCompact');

    // Session B is fresh — autoCompact runs (one brain call), succeeds,
    // TIER 3 is skipped.
    const healthyB = new RecordingBrain();
    healthyB.queueResponse(okResponse('B short summary'));
    const sessionB: MutableSession = { id: 'B', messages: makeFatHistory() };
    await escalateCompaction(healthyB, sessionB as never, makeState());
    expect(healthyB.calls).toHaveLength(1);
    expect(
      sessionB.messages.some((m) => m.content.includes('[AutoCompact summary]')),
    ).toBe(true);
    expect(
      sessionB.messages.some((m) => m.content.includes('[FullCompact')),
    ).toBe(false);
  });

  it('fail-open: both autoCompact and fullCompact throw → history untouched', async () => {
    const brain = new RecordingBrain();
    brain.queueResponse(new Error('autoCompact down'));
    brain.queueResponse(new Error('fullCompact down'));

    const session: MutableSession = { id: 't', messages: makeFatHistory() };
    const snapshot = JSON.stringify(session.messages);

    // Must not throw — escalateCompaction is fail-open by contract.
    await escalateCompaction(brain, session as never, makeState());

    // autoCompact swallows its own error internally; fullCompact's throw is
    // caught by escalateCompaction's outer try. Net: history unchanged.
    expect(JSON.stringify(session.messages)).toBe(snapshot);
    expect(brain.calls).toHaveLength(2);
  });
});
