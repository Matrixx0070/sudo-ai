/**
 * dedupeUserMessagesForCompaction — drops LATER duplicate user turns from the
 * summariser input so a re-sent prompt doesn't inflate/bias the summary. Keeps
 * the first occurrence, only touches long messages, leaves other roles alone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { dedupeUserMessagesForCompaction } from '../../src/core/agent/compaction.js';

const LONG = 'please refactor the authentication module and add tests';

afterEach(() => { delete process.env['SUDO_COMPACT_DEDUPE_USERS']; });

describe('dedupeUserMessagesForCompaction', () => {
  it('drops a later identical long user message, keeping the first', () => {
    const msgs = [
      { role: 'user', content: LONG },
      { role: 'assistant', content: 'working on it' },
      { role: 'user', content: LONG }, // duplicate
    ];
    const out = dedupeUserMessagesForCompaction(msgs);
    expect(out).toHaveLength(2);
    expect(out.filter((m) => (m as { role: string }).role === 'user')).toHaveLength(1);
  });

  it('normalizes whitespace/case when matching', () => {
    const out = dedupeUserMessagesForCompaction([
      { role: 'user', content: LONG },
      { role: 'user', content: `  ${LONG.toUpperCase()}  ` },
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps short acks and distinct messages', () => {
    const msgs = [
      { role: 'user', content: 'next' },
      { role: 'user', content: 'next' },        // short — not deduped
      { role: 'user', content: LONG },
      { role: 'user', content: `${LONG} plus one more thing` }, // distinct
    ];
    expect(dedupeUserMessagesForCompaction(msgs)).toHaveLength(4);
  });

  it('never drops non-user roles even if identical', () => {
    const msgs = [
      { role: 'assistant', content: LONG },
      { role: 'tool', content: LONG, toolCallId: '1' },
      { role: 'assistant', content: LONG },
    ];
    expect(dedupeUserMessagesForCompaction(msgs)).toHaveLength(3);
  });

  it('is a no-op when SUDO_COMPACT_DEDUPE_USERS=0', () => {
    process.env['SUDO_COMPACT_DEDUPE_USERS'] = '0';
    const msgs = [ { role: 'user', content: LONG }, { role: 'user', content: LONG } ];
    expect(dedupeUserMessagesForCompaction(msgs)).toHaveLength(2);
  });
});
