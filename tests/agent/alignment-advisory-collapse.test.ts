/**
 * Regression for alignment-advisory accumulation. The AlignmentAggregator
 * owner-loyalty check runs every loop iteration and pushes a near-identical
 * `[AlignmentAggregator] LEVEL=YELLOW …` system message each time. Left to pile
 * up, those most-recent duplicates fill the system-message window (keptSystem =
 * first + last two), evicting the turn's task guidance and burying the live
 * instruction. dropPriorAlignmentAdvisories collapses them to the latest one.
 */

import { describe, it, expect } from 'vitest';
import { dropPriorAlignmentAdvisories } from '../../src/core/agent/loop-helpers.js';

type Msg = { role: string; content?: unknown };

function advise(messages: Msg[], text: string): Msg[] {
  dropPriorAlignmentAdvisories(messages);
  messages.push({ role: 'system', content: text });
  return messages;
}

describe('dropPriorAlignmentAdvisories', () => {
  it('keeps only the latest advisory after repeated iterations', () => {
    let msgs: Msg[] = [
      { role: 'system', content: '## Today\nheartbeat' },
      { role: 'user', content: 'do the task' },
    ];
    advise(msgs, '[AlignmentAggregator] LEVEL=YELLOW SCORE=0.697 …');
    advise(msgs, '[AlignmentAggregator] LEVEL=YELLOW SCORE=0.695 …');
    advise(msgs, '[AlignmentAggregator] LEVEL=YELLOW SCORE=0.693 …');

    const advisories = msgs.filter(
      m => typeof m.content === 'string' && (m.content as string).startsWith('[AlignmentAggregator]'),
    );
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.content).toContain('0.693'); // the freshest
    // the durable header and the user instruction are untouched
    expect(msgs[0]!.content).toBe('## Today\nheartbeat');
    expect(msgs.some(m => m.role === 'user' && m.content === 'do the task')).toBe(true);
  });

  it('is a no-op when no advisory is present', () => {
    const msgs: Msg[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'working' },
    ];
    dropPriorAlignmentAdvisories(msgs);
    expect(msgs).toHaveLength(2);
  });

  it('only removes alignment advisories, not other system messages', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 'AUTO-ROUTING [INTENT: …]' },
      { role: 'system', content: '[AlignmentAggregator] LEVEL=YELLOW …' },
      { role: 'system', content: '# PLAN FOR THIS TASK' },
    ];
    dropPriorAlignmentAdvisories(msgs);
    expect(msgs.map(m => m.content)).toEqual([
      'AUTO-ROUTING [INTENT: …]',
      '# PLAN FOR THIS TASK',
    ]);
  });
});
