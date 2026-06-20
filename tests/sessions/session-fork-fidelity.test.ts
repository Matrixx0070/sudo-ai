/**
 * @file session-fork-fidelity.test.ts
 * @description Anti-telephone-game fix for buildForkSummary: when a session that
 * already contains a prior fork bridge is forked AGAIN, the prior "## Key Facts"
 * are carried into the summarization prompt verbatim so identifiers/codewords
 * survive repeated forks instead of eroding.
 */

import { describe, it, expect } from 'vitest';
import { extractPriorKeyFacts, forkSession } from '../../src/core/sessions/session-fork.js';
import type { BrainMessage, Session } from '../../src/core/sessions/types.js';

const PRIOR_BRIDGE = [
  '[SESSION FORK — continued from sess-old]',
  '',
  'The previous session reached its memory limit and was archived.',
  '',
  '## Context',
  'Building a rate limiter.',
  '## Decisions Made',
  '- token bucket',
  '## Open Tasks',
  '- write tests',
  '## Key Facts (IDs, paths, URLs, names)',
  '- codeword: ZEBRA-QUASAR-7731',
  '- config path: /etc/app/limits.yaml',
  '## Last User Request',
  'add Redis backing',
].join('\n');

describe('extractPriorKeyFacts', () => {
  it('pulls the ## Key Facts section out of the most recent fork bridge', () => {
    const facts = extractPriorKeyFacts([
      { role: 'system', content: PRIOR_BRIDGE },
      { role: 'user', content: 'continue' },
    ]);
    expect(facts).toContain('## Key Facts');
    expect(facts).toContain('ZEBRA-QUASAR-7731');
    expect(facts).toContain('/etc/app/limits.yaml');
    // stops at the next section — does NOT bleed into "## Last User Request"
    expect(facts).not.toContain('Last User Request');
  });

  it('returns "" when there is no prior fork bridge', () => {
    expect(extractPriorKeyFacts([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }])).toBe('');
  });

  it('returns "" for a fork bridge that somehow lacks a Key Facts section', () => {
    expect(extractPriorKeyFacts([{ role: 'system', content: '[SESSION FORK — continued from x]\n## Context\nstuff' }])).toBe('');
  });

  it('picks the MOST RECENT bridge when several exist', () => {
    const facts = extractPriorKeyFacts([
      { role: 'system', content: '[SESSION FORK — continued from a]\n## Key Facts\n- OLD-FACT-1' },
      { role: 'user', content: 'x' },
      { role: 'system', content: '[SESSION FORK — continued from b]\n## Key Facts\n- NEW-FACT-2' },
    ]);
    expect(facts).toContain('NEW-FACT-2');
    expect(facts).not.toContain('OLD-FACT-1');
  });
});

describe('forkSession carries prior key facts into the summarization prompt', () => {
  function makeSession(id: string, messages: BrainMessage[]): Session {
    return { id, channel: 'http', peerId: 'peer-1', messages } as unknown as Session;
  }

  it('FORK-FID-1: a re-fork includes the prior facts + a verbatim-preservation instruction', async () => {
    const captured: string[] = [];
    const brain = {
      call: async (opts: { messages: Array<{ role: string; content: string }> }) => {
        captured.push(opts.messages[0]!.content);
        return { content: '## Key Facts\n- codeword: ZEBRA-QUASAR-7731\n- new: thing' };
      },
    };
    const newSession = makeSession('sess-new', []);
    const sm = {
      getOrCreate: async () => newSession,
      archive: async () => undefined,
      save: async () => undefined,
    };
    const old = makeSession('sess-cur', [
      { role: 'system', content: PRIOR_BRIDGE },
      { role: 'user', content: 'keep going' },
      { role: 'assistant', content: 'sure' },
    ]);

    const result = await forkSession(old, brain, sm);

    // the summarization prompt carried the prior facts verbatim
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('CARRIED KEY FACTS');
    expect(captured[0]).toContain('ZEBRA-QUASAR-7731');
    expect(captured[0]).toContain('/etc/app/limits.yaml');
    // and the new bridge (built from the brain's summary) still carries the codeword
    expect(result).not.toBeNull();
    expect(result!.summary).toContain('ZEBRA-QUASAR-7731');
    const bridge = newSession.messages.find((m) => m.role === 'system' && m.content.includes('[SESSION FORK'));
    expect(bridge?.content).toContain('ZEBRA-QUASAR-7731');
  });

  it('FORK-FID-2: a FIRST fork (no prior bridge) sends no carried-facts block', async () => {
    const captured: string[] = [];
    const brain = {
      call: async (opts: { messages: Array<{ role: string; content: string }> }) => {
        captured.push(opts.messages[0]!.content);
        return { content: '## Key Facts\n- none' };
      },
    };
    const sm = {
      getOrCreate: async () => makeSession('sess-new', []),
      archive: async () => undefined,
      save: async () => undefined,
    };
    const old = makeSession('sess-cur', [
      { role: 'user', content: 'do a thing' },
      { role: 'assistant', content: 'done' },
    ]);

    await forkSession(old, brain, sm);
    expect(captured[0]).not.toContain('CARRIED KEY FACTS');
  });
});
