/**
 * @file session-fork-input-cap.test.ts
 * @description FORK_INPUT_MAX_CHARS — the fork-summary transcript is bounded.
 * 2026-07-29: a 699-message/1.2MB session (idle http channel; fork only fires
 * on the NEXT agent turn, so idle channels accumulate) produced a 712KB fork
 * prompt — the trigger for that day's RAG FTS event-loop wedge, plus real
 * token cost. The serialisation now keeps the TAIL under a char budget, notes
 * how many old messages were dropped, and still feeds extractIdentifiers from
 * the FULL raw history.
 */

import { describe, it, expect } from 'vitest';
import { forkSession, FORK_INPUT_MAX_CHARS } from '../../src/core/sessions/session-fork.js';
import type { BrainMessage, Session } from '../../src/core/sessions/types.js';

function makeSession(id: string, messages: BrainMessage[]): Session {
  return { id, channel: 'http', peerId: 'peer-1', messages } as unknown as Session;
}

function capturePrompt() {
  const captured: string[] = [];
  const brain = {
    call: async (opts: { messages: Array<{ role: string; content: string }> }) => {
      captured.push(opts.messages[0]!.content);
      return { content: '## Key Facts\n- summarised' };
    },
  };
  const sm = {
    getOrCreate: async () => makeSession('sess-new', []),
    archive: async () => undefined,
    save: async () => undefined,
  };
  return { captured, brain, sm };
}

describe('buildForkSummary input cap (2026-07-29 oversized-session incident)', () => {
  it('CAP-1: a 700-message session serialises to a bounded prompt with a dropped-messages note', async () => {
    const messages: BrainMessage[] = [];
    for (let i = 0; i < 700; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message number ${i} ` + 'x'.repeat(1900) });
    }
    const { captured, brain, sm } = capturePrompt();

    const result = await forkSession(makeSession('sess-big', messages), brain, sm);

    expect(result).not.toBeNull();
    expect(captured).toHaveLength(1);
    const prompt = captured[0]!;
    // Bounded: transcript budget + fixed prompt scaffolding head-room.
    expect(prompt.length).toBeLessThan(FORK_INPUT_MAX_CHARS + 20_000);
    // Tail-biased: the LAST message survives, the FIRST does not.
    expect(prompt).toContain('message number 699');
    expect(prompt).not.toContain('message number 0 ');
    // The summariser is told what was cut.
    expect(prompt).toMatch(/\[NOTE: the \d+ oldest messages were omitted for size/);
  });

  it('CAP-2: identifiers from DROPPED old messages still reach the prompt via extractIdentifiers', async () => {
    const messages: BrainMessage[] = [
      { role: 'user', content: 'the codeword is ZEBRA-QUASAR-7731 and the path is /etc/app/limits.yaml' },
    ];
    for (let i = 0; i < 400; i++) {
      messages.push({ role: 'assistant', content: 'filler '.repeat(300) });
    }
    const { captured, brain, sm } = capturePrompt();

    await forkSession(makeSession('sess-ids', messages), brain, sm);

    const prompt = captured[0]!;
    // The first message fell out of the transcript window…
    expect(prompt).toMatch(/oldest messages were omitted/);
    // …but its identifiers are force-fed via EXTRACTED IDENTIFIERS (full-history scan).
    expect(prompt).toContain('ZEBRA-QUASAR-7731');
    expect(prompt).toContain('/etc/app/limits.yaml');
  });

  it('CAP-3: a normal-sized session is serialised byte-identically (no note, nothing dropped)', async () => {
    const messages: BrainMessage[] = [
      { role: 'user', content: 'short question' },
      { role: 'assistant', content: 'short answer' },
    ];
    const { captured, brain, sm } = capturePrompt();

    await forkSession(makeSession('sess-small', messages), brain, sm);

    const prompt = captured[0]!;
    expect(prompt).not.toContain('omitted for size');
    expect(prompt).toContain('[USER]\nshort question');
    expect(prompt).toContain('[ASSISTANT]\nshort answer');
  });

  it('CAP-4: even a single oversized message is kept (never an empty transcript)', async () => {
    const messages: BrainMessage[] = [
      { role: 'user', content: 'y'.repeat(500_000) },
    ];
    const { captured, brain, sm } = capturePrompt();

    await forkSession(makeSession('sess-one', messages), brain, sm);

    // Per-message slice(0,2000) caps it; the one message survives whole-post-slice.
    expect(captured[0]!).toContain('[USER]\n' + 'y'.repeat(100));
  });
});
