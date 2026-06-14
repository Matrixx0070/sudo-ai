/**
 * Subagent resume_from (gap #21) — tests `loadResumeMessages` and
 * `seedResumeHistory` directly against a stub SessionManager. The full
 * AgentSwarm path is covered indirectly by the fail-open behaviour
 * here; an e2e test against the real swarm would need brain stubs and
 * is deferred (gap #21 v2 wires the public `system.spawn-agent` tool).
 */

import { describe, it, expect } from 'vitest';
import {
  loadResumeMessages,
  seedResumeHistory,
  subagentPeerKey,
  SUBAGENT_CHANNEL,
  type ResumeSessionManager,
  type ResumableMessage,
} from '../../src/core/agent/subagent-resume.js';

function stubSessionManager(
  storeByPeer: Record<string, { id: string; messages?: unknown }>,
  options: { throwOnGet?: boolean } = {},
): ResumeSessionManager {
  return {
    async getOrCreate(channel: string, peerId: string) {
      if (options.throwOnGet) throw new Error('boom');
      const key = `${channel}::${peerId}`;
      const existing = storeByPeer[key];
      if (existing) return existing;
      const fresh = { id: `id-for-${peerId}`, messages: [] as unknown[] };
      storeByPeer[key] = fresh;
      return fresh;
    },
  };
}

// ---------------------------------------------------------------------------
// peer key convention
// ---------------------------------------------------------------------------

describe('subagentPeerKey', () => {
  it('prefixes the agent id with the swarm convention', () => {
    expect(subagentPeerKey('a-1')).toBe('subagent:a-1');
    expect(SUBAGENT_CHANNEL).toBe('swarm');
  });
});

// ---------------------------------------------------------------------------
// loadResumeMessages
// ---------------------------------------------------------------------------

describe('loadResumeMessages', () => {
  it('returns the prior agent\'s messages (excluding system — verifier BLOCKER)', async () => {
    const transcript = [
      // System messages are filtered out because Brain.toSDKMessages drops
      // them with a warn — keeping them here would have been a silent
      // contract violation. See subagent-resume.ts JSDoc.
      { role: 'system', content: 'you are a helper' },
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'tool needed', toolCalls: [{ id: 'c1' }] },
      { role: 'tool', content: 'tool result', toolCallId: 'c1' },
      { role: 'assistant', content: 'final answer' },
    ];
    const mgr = stubSessionManager({
      'swarm::subagent:agent-7': { id: 's-1', messages: transcript },
    });

    const loaded = await loadResumeMessages(mgr, 'agent-7');
    expect(loaded).toHaveLength(4);
    expect(loaded.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    // toolCalls and toolCallId metadata survive
    expect(loaded[1]?.toolCalls).toEqual([{ id: 'c1' }]);
    expect(loaded[2]?.toolCallId).toBe('c1');
  });

  it('explicitly drops system messages so brain.toSDKMessages never sees them', async () => {
    const mgr = stubSessionManager({
      'swarm::subagent:sys-only': {
        id: 's',
        messages: [
          { role: 'system', content: 'old persona' },
          { role: 'system', content: 'another system' },
        ],
      },
    });
    const loaded = await loadResumeMessages(mgr, 'sys-only');
    expect(loaded).toEqual([]);
  });

  it('returns empty for unknown agent ids (the stub creates a fresh empty session)', async () => {
    const mgr = stubSessionManager({});
    const loaded = await loadResumeMessages(mgr, 'never-existed');
    expect(loaded).toEqual([]);
  });

  it('returns empty when messages is not an array', async () => {
    const mgr = stubSessionManager({
      'swarm::subagent:bad': { id: 's', messages: 'not an array' as unknown },
    });
    const loaded = await loadResumeMessages(mgr, 'bad');
    expect(loaded).toEqual([]);
  });

  it('returns empty when the session manager throws — fail open', async () => {
    const mgr = stubSessionManager({}, { throwOnGet: true });
    const loaded = await loadResumeMessages(mgr, 'a');
    expect(loaded).toEqual([]);
  });

  it('returns empty for an empty / non-string agent id', async () => {
    const mgr = stubSessionManager({});
    expect(await loadResumeMessages(mgr, '')).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await loadResumeMessages(mgr, undefined as any)).toEqual([]);
  });

  it('filters out malformed message entries (missing role)', async () => {
    const mgr = stubSessionManager({
      'swarm::subagent:agent-mix': {
        id: 's',
        messages: [
          { role: 'user', content: 'ok' },
          { content: 'no role' },
          null,
          { role: 'assistant', content: 'ok' },
        ],
      },
    });
    const loaded = await loadResumeMessages(mgr, 'agent-mix');
    expect(loaded).toHaveLength(2);
    expect(loaded.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

// ---------------------------------------------------------------------------
// seedResumeHistory
// ---------------------------------------------------------------------------

describe('seedResumeHistory', () => {
  it('returns 0 and is a no-op when resumed is empty', () => {
    const session = { messages: [{ role: 'user', content: 'existing' }] };
    expect(seedResumeHistory(session, [])).toBe(0);
    expect(session.messages).toEqual([{ role: 'user', content: 'existing' }]);
  });

  it('returns 0 when resumed is not an array', () => {
    const session = { messages: [] as ResumableMessage[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(seedResumeHistory(session, undefined as any)).toBe(0);
  });

  it('prepends the resumed messages onto session.messages (pre-existing entries pushed back)', () => {
    const session = {
      messages: [{ role: 'system', content: 'fresh system seed from session manager' }],
    };
    const resumed: ResumableMessage[] = [
      { role: 'user', content: 'prior 1' },
      { role: 'assistant', content: 'prior 2' },
    ];
    expect(seedResumeHistory(session, resumed)).toBe(2);
    expect(session.messages.map((m) => m.content)).toEqual([
      'prior 1',
      'prior 2',
      'fresh system seed from session manager',
    ]);
  });

  it('creates messages array if the session has none', () => {
    const session: { messages?: ResumableMessage[] } = {};
    const resumed: ResumableMessage[] = [{ role: 'user', content: 'x' }];
    expect(seedResumeHistory(session, resumed)).toBe(1);
    expect(session.messages).toEqual(resumed);
  });

  it('preserves tool-call metadata on the spliced messages (AI SDK pairing)', () => {
    const session = { messages: [] as ResumableMessage[] };
    const resumed: ResumableMessage[] = [
      { role: 'assistant', content: 'using tool', toolCalls: [{ id: 'c1', name: 'bash' }] },
      { role: 'tool', content: 'ok', toolCallId: 'c1', toolName: 'bash' },
    ];
    seedResumeHistory(session, resumed);
    expect(session.messages[0]?.toolCalls).toEqual([{ id: 'c1', name: 'bash' }]);
    expect(session.messages[1]?.toolCallId).toBe('c1');
    expect(session.messages[1]?.toolName).toBe('bash');
  });
});

// ---------------------------------------------------------------------------
// End-to-end (helper level): loadResumeMessages → seedResumeHistory
// ---------------------------------------------------------------------------

describe('load + seed pipeline', () => {
  it('round-trips a transcript from a finished sub-agent into a fresh session (system stripped)', async () => {
    const transcript: ResumableMessage[] = [
      { role: 'system', content: 'helper' },
      { role: 'user', content: 'do A' },
      { role: 'assistant', content: 'done A' },
    ];
    const mgr = stubSessionManager({
      'swarm::subagent:done-1': { id: 's1', messages: transcript },
    });

    const loaded = await loadResumeMessages(mgr, 'done-1');
    const fresh = { messages: [] as ResumableMessage[] };
    const kept = seedResumeHistory(fresh, loaded);
    // System message dropped (BLOCKER fix) — only user + assistant survive.
    expect(kept).toBe(2);
    expect(fresh.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});
