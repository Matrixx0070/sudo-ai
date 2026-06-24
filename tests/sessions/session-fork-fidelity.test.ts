/**
 * @file session-fork-fidelity.test.ts
 * @description Anti-telephone-game fix for buildForkSummary: when a session that
 * already contains a prior fork bridge is forked AGAIN, the prior "## Key Facts"
 * are carried into the summarization prompt verbatim so identifiers/codewords
 * survive repeated forks instead of eroding.
 */

import { describe, it, expect } from 'vitest';
import { extractPriorKeyFacts, extractIdentifiers, forkSession } from '../../src/core/sessions/session-fork.js';
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

describe('extractIdentifiers (first-capture)', () => {
  it('extracts codewords, URLs, emails, UUIDs, paths, hashes from user/assistant content', () => {
    const ids = extractIdentifiers([
      { role: 'user', content: 'codeword ZEBRA-QUASAR-7731, see https://api.example.com/v2/x and email a@b.co' },
      { role: 'assistant', content: 'config /etc/app/limits.yaml, uuid 550e8400-e29b-41d4-a716-446655440000, hash deadbeefcafe1234' },
    ]);
    expect(ids).toContain('ZEBRA-QUASAR-7731');
    expect(ids).toContain('https://api.example.com/v2/x');
    expect(ids).toContain('a@b.co');
    expect(ids).toContain('/etc/app/limits.yaml');
    expect(ids).toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(ids).toContain('deadbeefcafe1234');
  });

  it('skips system content (no AUTO-ROUTING / SESSION-FORK noise) and dedupes', () => {
    const ids = extractIdentifiers([
      { role: 'system', content: 'AUTO-ROUTING [INTENT]\n[SESSION FORK — continued]' },
      { role: 'user', content: 'KEEP-THIS-1 and KEEP-THIS-1 again' },
    ]);
    expect(ids).toContain('KEEP-THIS-1');
    expect(ids.filter((x) => x === 'KEEP-THIS-1')).toHaveLength(1);
    expect(ids).not.toContain('AUTO-ROUTING');
    expect(ids).not.toContain('SESSION-FORK');
  });

  it('respects the cap and returns [] when nothing matches', () => {
    const many: BrainMessage[] = [{ role: 'user', content: Array.from({ length: 60 }, (_, i) => `TOK-${i}-X`).join(' ') }];
    expect(extractIdentifiers(many, 10)).toHaveLength(10);
    expect(extractIdentifiers([{ role: 'user', content: 'just some plain words here' }])).toEqual([]);
  });
});

describe('forkSession first-capture: extracted identifiers reach the prompt', () => {
  function makeSession(id: string, messages: BrainMessage[]): Session {
    return { id, channel: 'http', peerId: 'peer-1', messages } as unknown as Session;
  }

  it('FORK-FID-3: a FIRST fork forces a user-mentioned codeword into the prompt even with no prior bridge', async () => {
    const captured: string[] = [];
    const brain = {
      call: async (o: { messages: Array<{ role: string; content: string }> }) => {
        captured.push(o.messages[0]!.content);
        return { content: '## Key Facts\n- ok' };
      },
    };
    const sm = { getOrCreate: async () => makeSession('new', []), archive: async () => undefined, save: async () => undefined };
    const old = makeSession('cur', [
      { role: 'user', content: 'Please remember the deploy key MAGENTA-FALCON-5519 for later.' },
      { role: 'assistant', content: 'Noted.' },
    ]);

    await forkSession(old, brain, sm);
    expect(captured[0]).toContain('EXTRACTED IDENTIFIERS');
    expect(captured[0]).toContain('MAGENTA-FALCON-5519');
    expect(captured[0]).not.toContain('CARRIED KEY FACTS'); // first fork → no prior bridge
  });
});

describe('forkSession — rich Claude-Code-style handoff brief (Phase 1)', () => {
  function makeSession(id: string, messages: BrainMessage[]): Session {
    return { id, channel: 'telegram', peerId: 'peer-9', messages } as unknown as Session;
  }

  it('FORK-RICH-1: the prompt asks for all 9 sections incl. verbatim user messages', async () => {
    let prompt = '';
    const brain = {
      call: async (o: { messages: Array<{ role: string; content: string }> }) => {
        prompt = o.messages[0]!.content;
        return { content: 'ok' };
      },
    };
    const sm = { getOrCreate: async () => makeSession('new', []), archive: async () => undefined, save: async () => undefined };
    await forkSession(
      makeSession('cur', [{ role: 'user', content: 'do X' }, { role: 'assistant', content: 'ok' }]),
      brain,
      sm,
    );
    for (const h of [
      '## 1. Primary Request',
      '## 2. Key Technical Concepts',
      '## 4. Errors & Fixes',
      '## 6. All User Messages',
      '## 8. Current Work',
      '## 9. Next Step',
    ]) {
      expect(prompt).toContain(h);
    }
    expect(prompt).toContain('verbatim'); // the "never drop a user message" instruction
  });

  it('FORK-RICH-2: on brain failure the fallback preserves recent user messages verbatim', async () => {
    const brain = { call: async () => { throw new Error('brain down'); } };
    const sm = { getOrCreate: async () => makeSession('new', []), archive: async () => undefined, save: async () => undefined };
    const old = makeSession('cur', [
      { role: 'user', content: 'FIRST ask: build the SEO report for ACME-SITE-42' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'SECOND ask: also check rankings' },
    ]);
    const result = await forkSession(old, brain, sm);
    expect(result).not.toBeNull();
    expect(result!.summary).toContain('## 6. All User Messages');
    expect(result!.summary).toContain('FIRST ask');
    expect(result!.summary).toContain('SECOND ask');     // every recent user message, not just the last
    expect(result!.summary).toContain('ACME-SITE-42');   // identifier preserved in the fallback too
  });
});
