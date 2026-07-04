/**
 * @file tests/agent/precompaction-flush.test.ts
 * @description The programmatic pre-compaction flush is now WIRED: runCompaction
 * invokes the injected preFlush (persisting salient facts) before compact()
 * replaces the history, and is fail-open (a flush error never blocks compaction).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runCompaction,
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
  '- Pending asks: awaiting deploy',
  '- Identifiers: repo/main',
].join('\n');

function makeState(): AgentState {
  return {
    sessionId: 'sess', iteration: 0, isProcessing: false, isCompacting: false,
    pendingToolCalls: 0, followUpMessages: [], consecutiveReplans: 0,
  } as AgentState;
}

class StubBrain implements BrainLike {
  async call(_req: BrainRequest): Promise<BrainResponse> {
    return { content: VALID_SUMMARY } as BrainResponse;
  }
}

function session(): SessionLike {
  const messages: BrainMessage[] = [
    { role: 'user', content: 'the user asked to deploy' },
    { role: 'assistant', content: 'working on the deploy' },
  ];
  return { id: 'sess', messages } as SessionLike;
}

const noopEmit = () => {};

describe('runCompaction pre-compaction flush wiring', () => {
  it('invokes preFlush with the conversation messages before compacting', async () => {
    const seen: BrainMessage[][] = [];
    const preFlush = vi.fn(async (msgs: BrainMessage[]) => { seen.push([...msgs]); });
    const sess = session();

    const summary = await runCompaction(new StubBrain(), sess, makeState(), noopEmit, undefined, preFlush);

    expect(preFlush).toHaveBeenCalledTimes(1);
    // Called with the real conversation (before compact replaces it).
    expect(seen[0]!.some((m) => m.content === 'the user asked to deploy')).toBe(true);
    expect(summary).toContain('Decisions');
  });

  it('is fail-open: a throwing preFlush does not block compaction', async () => {
    const preFlush = vi.fn(async () => { throw new Error('storage down'); });
    const summary = await runCompaction(new StubBrain(), session(), makeState(), noopEmit, undefined, preFlush);
    expect(preFlush).toHaveBeenCalledTimes(1);
    expect(summary).toContain('Decisions'); // compaction still succeeded
  });

  it('is time-bounded: a hanging preFlush does not stall compaction', async () => {
    const prev = process.env['SUDO_PRECOMPACTION_FLUSH_TIMEOUT_MS'];
    process.env['SUDO_PRECOMPACTION_FLUSH_TIMEOUT_MS'] = '50';
    try {
      const preFlush = vi.fn(() => new Promise<void>(() => { /* never resolves */ }));
      const summary = await runCompaction(new StubBrain(), session(), makeState(), noopEmit, undefined, preFlush);
      // Compaction proceeded past the hung flush (abandoned after the timeout).
      expect(summary).toContain('Decisions');
    } finally {
      if (prev === undefined) delete process.env['SUDO_PRECOMPACTION_FLUSH_TIMEOUT_MS'];
      else process.env['SUDO_PRECOMPACTION_FLUSH_TIMEOUT_MS'] = prev;
    }
  });

  it('no preFlush → compaction runs normally', async () => {
    const summary = await runCompaction(new StubBrain(), session(), makeState(), noopEmit);
    expect(summary).toContain('Decisions');
  });
});
