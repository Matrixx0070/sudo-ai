/**
 * KAIROS self-repair used to compute a full refactor every ~5 minutes and drop
 * it on the floor. Three layers hid the work product:
 *   1. the trigger passes applyEdits:false (deliberate — no unsupervised edits
 *      to prod code), so `parsed.edits` was never applied;
 *   2. the report skips the AI text whenever edits exist on a mutating mode,
 *      and lists `applyResult.applied`, which is empty on a dry run;
 *   3. triggerKAIROSRepair truncated the report to 300 chars.
 * Net effect: ~288 refactors/day at full token cost, none of them recoverable.
 *
 * The arsenal pipeline needs a live model, so these pin the two pieces that are
 * testable in isolation: the dedupe rule (which stops ~288 identical rows/day)
 * and the sink seam.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setKairosProposalSink,
  shouldPersistKairosProposal,
  _resetKairosProposalDedupeForTests,
  type KairosProposal,
} from '../../../src/core/tools/builtin/coder/arsenal.js';

const OBS_A = 'KAIROS: 37 file(s) exceed 750 lines:\nsrc/core/agent/loop.ts (3556 lines)';
const OBS_B = 'KAIROS: 36 file(s) exceed 750 lines:\nsrc/core/agent/loop.ts (3556 lines)';

describe('KAIROS proposal dedupe', () => {
  beforeEach(() => {
    _resetKairosProposalDedupeForTests();
    setKairosProposalSink(undefined);
  });

  it('persists the first sighting of an observation', () => {
    expect(shouldPersistKairosProposal(OBS_A, 'refactor')).toBe(true);
  });

  it('suppresses an unchanged observation — this is the 288-rows/day fix', () => {
    expect(shouldPersistKairosProposal(OBS_A, 'refactor')).toBe(true);
    for (let tick = 0; tick < 50; tick++) {
      expect(shouldPersistKairosProposal(OBS_A, 'refactor')).toBe(false);
    }
  });

  it('persists again once the observation actually changes', () => {
    expect(shouldPersistKairosProposal(OBS_A, 'refactor')).toBe(true);
    expect(shouldPersistKairosProposal(OBS_A, 'refactor')).toBe(false);
    // 37 files -> 36: the codebase changed, so this is genuinely new.
    expect(shouldPersistKairosProposal(OBS_B, 'refactor')).toBe(true);
    expect(shouldPersistKairosProposal(OBS_B, 'refactor')).toBe(false);
  });

  it('treats the same text under a different mode as distinct', () => {
    expect(shouldPersistKairosProposal(OBS_A, 'refactor')).toBe(true);
    expect(shouldPersistKairosProposal(OBS_A, 'fix')).toBe(true);
  });
});

describe('KAIROS proposal sink seam', () => {
  beforeEach(() => {
    _resetKairosProposalDedupeForTests();
    setKairosProposalSink(undefined);
  });

  it('is injectable and clearable without throwing', () => {
    expect(() => setKairosProposalSink(() => {})).not.toThrow();
    expect(() => setKairosProposalSink(undefined)).not.toThrow();
  });

  /**
   * The KairosProposal contract must carry file CONTENT, not just paths —
   * paths alone would reproduce the original bug in a new shape (a reviewer
   * still couldn't see what would change). The sink itself is module-private
   * and only fires from a live arsenal run, so this pins the payload shape
   * rather than pretending to exercise the invocation.
   */
  it('the proposal contract carries file content, not just paths', () => {
    const proposal: KairosProposal = {
      task: OBS_A,
      mode: 'refactor',
      report: '**[CODER.ARSENAL — Kimi K2.7 Code (Ollama) — REFACTOR]**',
      edits: [{ filePath: 'src/a.ts', content: 'export const a = 1;\n' }],
    };
    expect(proposal.edits[0]!.content).toContain('export const a = 1;');
    expect(proposal.edits[0]!.filePath).toBe('src/a.ts');
  });
});
