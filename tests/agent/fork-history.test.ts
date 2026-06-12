/**
 * @file tests/agent/fork-history.test.ts
 * @description Fork-mode history filtering (gap #10) — a forked sub-agent
 * inherits system/user messages and final-answer assistant messages only;
 * tool results and intermediate assistant turns are dropped.
 */

import { describe, it, expect } from 'vitest';
import { filterForkedHistory, seedForkedHistory } from '../../src/core/agent/fork-history.js';
import type { ForkableMessage } from '../../src/core/agent/fork-history.js';

const history: ForkableMessage[] = [
  { role: 'system', content: 'You are SUDO-AI.' },
  { role: 'user', content: 'Refactor the auth module.' },
  { role: 'assistant', content: 'Reading files first.', toolCalls: [{ id: 't1', name: 'fs.read' }] },
  { role: 'tool', content: '{"ok":true}' },
  { role: 'assistant', content: 'Here is the refactor plan: ...' },
  { role: 'user', content: 'Looks good, apply it.' },
  { role: 'assistant', content: 'Applying.', toolCalls: [{ id: 't2', name: 'fs.write' }] },
  { role: 'tool', content: 'written' },
  { role: 'assistant', content: 'Done. Auth module refactored.' },
];

describe('filterForkedHistory', () => {
  it('keeps system, user, and final-answer assistant messages in order', () => {
    const kept = filterForkedHistory(history);
    expect(kept.map((m) => m.content)).toEqual([
      'You are SUDO-AI.',
      'Refactor the auth module.',
      'Here is the refactor plan: ...',
      'Looks good, apply it.',
      'Done. Auth module refactored.',
    ]);
  });

  it('drops tool messages and assistant turns that carry tool calls', () => {
    const kept = filterForkedHistory(history);
    expect(kept.some((m) => m.role === 'tool')).toBe(false);
    expect(kept.some((m) => Array.isArray(m.toolCalls) && m.toolCalls.length > 0)).toBe(false);
  });

  it('keeps assistant messages with an empty toolCalls array (final answers)', () => {
    const kept = filterForkedHistory([
      { role: 'assistant', content: 'final', toolCalls: [] },
    ]);
    expect(kept).toHaveLength(1);
  });

  it('does not mutate the input and handles empty history', () => {
    const input = [...history];
    filterForkedHistory(input);
    expect(input).toHaveLength(history.length);
    expect(filterForkedHistory([])).toEqual([]);
  });
});

describe('seedForkedHistory', () => {
  it('appends only the filtered messages and reports the kept count', () => {
    const session = { messages: [{ role: 'system', content: 'sub-agent boot' }] as ForkableMessage[] };
    const kept = seedForkedHistory(session, history);
    expect(kept).toBe(5);
    expect(session.messages).toHaveLength(6);
    expect(session.messages[1]!.content).toBe('You are SUDO-AI.');
    expect(session.messages.at(-1)!.content).toBe('Done. Auth module refactored.');
  });

  it('is a no-op when the session has no messages array', () => {
    expect(seedForkedHistory({}, history)).toBe(0);
    expect(seedForkedHistory({ messages: 'not-an-array' }, history)).toBe(0);
  });
});
