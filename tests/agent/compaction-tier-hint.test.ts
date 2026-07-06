/**
 * Compaction tier hint: brain.call receives tier 'routine' by default at
 * every compaction site (compaction has its own retry loop as the
 * malformed-summary guard, so the multi-round strategy upgrade is opt-in),
 * and 'high-stakes' when SUDO_COMPACTION_HIGH_STAKES=1.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const savedEnv = process.env['SUDO_COMPACTION_HIGH_STAKES'];

describe('compaction → brain.call tier hint', () => {
  beforeEach(() => {
    // autoCompact uses a module-level failure counter that can be polluted by
    // other tests in the suite (e.g. compaction-escalation). Reset to ensure
    // the brain call gate isn't short-circuited.
    resetAutoCompactFailures();
    delete process.env['SUDO_COMPACTION_HIGH_STAKES'];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['SUDO_COMPACTION_HIGH_STAKES'];
    else process.env['SUDO_COMPACTION_HIGH_STAKES'] = savedEnv;
  });

  it('compact() (primary, 5-section) defaults to tier routine', async () => {
    const call = vi.fn().mockResolvedValue({ content: VALID_SUMMARY });
    const brain = { call };

    await compact(brain, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1]).toEqual({ tier: 'routine' });
  });

  it('compact() forwards high-stakes when SUDO_COMPACTION_HIGH_STAKES=1', async () => {
    process.env['SUDO_COMPACTION_HIGH_STAKES'] = '1';
    const call = vi.fn().mockResolvedValue({ content: VALID_SUMMARY });
    const brain = { call };

    await compact(brain, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);

    expect(call.mock.calls[0]?.[1]).toEqual({ tier: 'high-stakes' });
  });

  it('autoCompact() (middle-slice fallback) defaults to tier routine', async () => {
    const call = vi.fn().mockResolvedValue({ content: 'summary' });
    const brain = { call };

    // Build a long history so autoCompact actually fires the brain call;
    // currentTokens needs to exceed (tokenLimit - reserveTokens).
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: 'x'.repeat(2000),
    }));
    const tokenLimit = 100;
    const currentTokens = 100_000;

    await autoCompact(history, brain, currentTokens, tokenLimit);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1]).toEqual({ tier: 'routine' });
  });

  it('fullCompact() (nuclear reset) defaults to tier routine', async () => {
    const call = vi.fn().mockResolvedValue({ content: 'dense summary' });
    const brain = { call };

    await fullCompact([{ role: 'user', content: 'hello' }], brain);

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1]).toEqual({ tier: 'routine' });
  });
});
