/**
 * Compaction passes `tier: 'high-stakes'` to brain.call at every site.
 *
 * Verifies the wire-in from PR #243 (Stage 2 follow-up to the
 * task-decomposer wire-in in #242). Each compaction call site is a
 * one-shot per fill event and a malformed summary loses context for
 * every subsequent turn — exactly the high-stakes signal the
 * env-driven strategy upgrade is meant to catch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  compact,
  autoCompact,
  fullCompact,
  resetAutoCompactFailures,
} from '../../src/core/agent/compaction.js';

/** Valid 5-section summary so compact() returns on attempt 1. */
const VALID_SUMMARY = [
  '## Decisions',
  '- ship it',
  '## Open TODOs',
  '- finish tests',
  '## Constraints',
  '- keep tier hint',
  '## Pending asks',
  '- none',
  '## Identifiers',
  '- PR #243',
].join('\n');

describe('compaction → brain.call passes tier: high-stakes', () => {
  beforeEach(() => {
    // autoCompact uses a module-level failure counter that can be polluted by
    // other tests in the suite (e.g. compaction-escalation). Reset to ensure
    // the brain call gate isn't short-circuited.
    resetAutoCompactFailures();
  });

  it('compact() (primary, 5-section) forwards the tier hint', async () => {
    const call = vi.fn().mockResolvedValue({ content: VALID_SUMMARY });
    const brain = { call };

    await compact(brain, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1]).toEqual({ tier: 'high-stakes' });
  });

  it('autoCompact() (middle-slice fallback) forwards the tier hint', async () => {
    const call = vi.fn().mockResolvedValue({ content: 'summary' });
    const brain = { call };

    // Build a long history so autoCompact actually fires the brain call;
    // currentTokens needs to exceed (tokenLimit - reserveTokens).
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: 'x'.repeat(2000),
    }));
    // autoCompact signature: (history, brain, currentTokens, tokenLimit, options?)
    // Gate to enter brain call: currentTokens > tokenLimit - reserveTokens (reserve default 13000)
    const tokenLimit = 100;
    const currentTokens = 100_000;

    await autoCompact(history, brain, currentTokens, tokenLimit);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1]).toEqual({ tier: 'high-stakes' });
  });

  it('fullCompact() (nuclear reset) forwards the tier hint', async () => {
    const call = vi.fn().mockResolvedValue({ content: 'dense summary' });
    const brain = { call };

    await fullCompact([{ role: 'user', content: 'hello' }], brain);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1]).toEqual({ tier: 'high-stakes' });
  });
});
