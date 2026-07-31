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

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  setKairosProposalSink,
  shouldPersistKairosProposal,
  isNewKairosObservation,
  normalizeKairosObservation,
  consumeKairosRepairBudget,
  isKairosRepairDemandOnly,
  triggerKAIROSRepair,
  _resetKairosProposalDedupeForTests,
  _simulateKairosRestartForTests,
  type KairosProposal,
} from '../../../src/core/tools/builtin/coder/arsenal.js';

// Latch state now persists to disk; point it at a temp file so tests never
// create <repo>/data/ (which flips the cw6-homeostat suite).
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'kairos-latch-'));
const TMP_LATCH = path.join(TMP_DIR, 'latch.json');
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

const OBS_A = 'KAIROS: 37 file(s) exceed 750 lines:\nsrc/core/agent/loop.ts (3556 lines)';
const OBS_B = 'KAIROS: 36 file(s) exceed 750 lines:\nsrc/core/agent/loop.ts (3556 lines)';

describe('KAIROS proposal dedupe', () => {
  beforeEach(() => {
    _resetKairosProposalDedupeForTests(TMP_LATCH);
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
    _resetKairosProposalDedupeForTests(TMP_LATCH);
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

/**
 * 2026-07-29, second half of the story. Making the dry-run output LAND stopped
 * the waste of the result, not the waste of the call: KAIROS still re-ran an
 * identical analysis every ~5 minutes because its only remedy (a dry run)
 * cannot clear the condition that triggers it.
 *
 * coder.arsenal burned 6.5M input tokens that day — ~31% of ALL ollama
 * consumption, 164 calls at ~80k in / 32,768 out. Tolerable when ollama was one
 * profile among several; not once an org-level OAuth 403 removed every
 * claude-oauth profile and left ollama load-bearing for the brain, with weekly
 * quota at 89.3% and four days to reset. The repair loop was competing for
 * quota with the user turns it exists to protect.
 */
describe('KAIROS repeat-observation latch (gates the CALL, not just the write)', () => {
  beforeEach(() => {
    _resetKairosProposalDedupeForTests(TMP_LATCH);
    setKairosProposalSink(undefined);
  });

  it('analyses a new observation', () => {
    expect(isNewKairosObservation(OBS_A, 'refactor')).toBe(true);
  });

  it('skips the identical observation on every subsequent tick', () => {
    expect(isNewKairosObservation(OBS_A, 'refactor')).toBe(true);
    // 12 ticks/hour × 24h is the real cadence; all of it is now skipped.
    for (let tick = 0; tick < 288; tick++) {
      expect(isNewKairosObservation(OBS_A, 'refactor')).toBe(false);
    }
  });

  it('a CHANGED observation still runs immediately — capability preserved', () => {
    expect(isNewKairosObservation(OBS_A, 'refactor')).toBe(true);
    expect(isNewKairosObservation(OBS_A, 'refactor')).toBe(false);
    expect(isNewKairosObservation(OBS_B, 'refactor')).toBe(true);
  });

  it('attempt and persist latches are INDEPENDENT — sharing one would drop every proposal', () => {
    // Attempt latches first; persist must still see this observation as new,
    // or the proposal computed on this very tick would never be written.
    expect(isNewKairosObservation(OBS_A, 'refactor')).toBe(true);
    expect(shouldPersistKairosProposal(OBS_A, 'refactor')).toBe(true);
  });
});

/**
 * 2026-07-31, third half of the story. The 07-29 latch was a module-level
 * variable: every daemon restart wiped it and re-ran the full ~80k-token
 * pipeline for an UNCHANGED observation. Live-proven: six restarts in one
 * morning → six full re-runs, one minute after each. The latch now persists
 * to disk and the key ignores pure drift (line counts, tsc positions).
 */
describe('KAIROS latch survives restarts (disk persistence)', () => {
  beforeEach(() => {
    _resetKairosProposalDedupeForTests(TMP_LATCH);
    setKairosProposalSink(undefined);
  });

  it('an unchanged observation stays latched across a restart', () => {
    expect(isNewKairosObservation(OBS_A, 'refactor')).toBe(true);
    _simulateKairosRestartForTests(); // memory gone, file stays
    expect(isNewKairosObservation(OBS_A, 'refactor')).toBe(false);
  });

  it('the persist latch also survives a restart', () => {
    expect(shouldPersistKairosProposal(OBS_A, 'refactor')).toBe(true);
    _simulateKairosRestartForTests();
    expect(shouldPersistKairosProposal(OBS_A, 'refactor')).toBe(false);
  });

  it('a genuinely new observation still runs after a restart — capability preserved', () => {
    expect(isNewKairosObservation(OBS_A, 'refactor')).toBe(true);
    _simulateKairosRestartForTests();
    expect(isNewKairosObservation(OBS_B, 'refactor')).toBe(true);
  });
});

describe('KAIROS observation normalization (drift-proof dedupe key)', () => {
  beforeEach(() => {
    _resetKairosProposalDedupeForTests(TMP_LATCH);
  });

  it('line-count drift in a listed file does NOT re-key the observation', () => {
    const drifted = OBS_A.replace('(3556 lines)', '(3557 lines)');
    expect(isNewKairosObservation(OBS_A, 'refactor')).toBe(true);
    expect(isNewKairosObservation(drifted, 'refactor')).toBe(false);
  });

  it('tsc position drift does NOT re-key a fix observation', () => {
    const errA = 'KAIROS: 3 error(s)\nsrc/x.ts(123,4): error TS2345: nope';
    const errB = 'KAIROS: 3 error(s)\nsrc/x.ts(125,9): error TS2345: nope';
    expect(isNewKairosObservation(errA, 'fix')).toBe(true);
    expect(isNewKairosObservation(errB, 'fix')).toBe(false);
  });

  it('a changed FILE COUNT still re-keys — kairos truncates the list, the count is real signal', () => {
    expect(normalizeKairosObservation(OBS_A)).not.toBe(normalizeKairosObservation(OBS_B));
  });

  it('a changed error code still re-keys', () => {
    const errA = 'src/x.ts(1,1): error TS2345: nope';
    const errB = 'src/x.ts(1,1): error TS7006: nope';
    expect(isNewKairosObservation(errA, 'fix')).toBe(true);
    expect(isNewKairosObservation(errB, 'fix')).toBe(true);
  });
});

describe('KAIROS per-day repair budget (invariant 10)', () => {
  beforeEach(() => {
    _resetKairosProposalDedupeForTests(TMP_LATCH);
    delete process.env['SUDO_KAIROS_REPAIR_MAX_PER_DAY'];
  });

  it('allows the default 4 runs then blocks', () => {
    for (let i = 1; i <= 4; i++) {
      expect(consumeKairosRepairBudget()).toEqual({ allowed: true, used: i, max: 4 });
    }
    expect(consumeKairosRepairBudget().allowed).toBe(false);
  });

  it('honors the env override', () => {
    process.env['SUDO_KAIROS_REPAIR_MAX_PER_DAY'] = '1';
    expect(consumeKairosRepairBudget().allowed).toBe(true);
    expect(consumeKairosRepairBudget().allowed).toBe(false);
  });

  it('0 is a kill switch', () => {
    process.env['SUDO_KAIROS_REPAIR_MAX_PER_DAY'] = '0';
    expect(consumeKairosRepairBudget().allowed).toBe(false);
  });

  it('the spent budget survives a restart', () => {
    process.env['SUDO_KAIROS_REPAIR_MAX_PER_DAY'] = '1';
    expect(consumeKairosRepairBudget().allowed).toBe(true);
    _simulateKairosRestartForTests();
    expect(consumeKairosRepairBudget().allowed).toBe(false);
  });

  it('invalid values fall back to the default', () => {
    process.env['SUDO_KAIROS_REPAIR_MAX_PER_DAY'] = 'banana';
    expect(consumeKairosRepairBudget().max).toBe(4);
  });
});

/**
 * 2026-07-31, ADR-0006 (Frank GO). The timer-driven loop is demoted to
 * demand-driven: with SUDO_KAIROS_REPAIR_DEMAND_ONLY=1 the KAIROS tick may
 * observe but never fires the ~80k-token analysis. The check sits FIRST in
 * triggerKAIROSRepair so demand-only ticks consume no latch state and no
 * budget — a later flag flip must see the observation as genuinely new.
 */
describe('ADR-0006 demand-only demotion', () => {
  beforeEach(() => {
    _resetKairosProposalDedupeForTests(TMP_LATCH);
    setKairosProposalSink(undefined);
    delete process.env['SUDO_KAIROS_REPAIR_DEMAND_ONLY'];
  });

  it('flag off → not demand-only (current prod default until activation)', () => {
    expect(isKairosRepairDemandOnly()).toBe(false);
  });

  it('demand-only skips the autonomous run without touching a model', async () => {
    process.env['SUDO_KAIROS_REPAIR_DEMAND_ONLY'] = '1';
    const res = await triggerKAIROSRepair(OBS_A, 'refactor');
    expect(res.success).toBe(true);
    expect(res.output).toContain('demand-only');
  });

  it('demand-only consumes neither latch nor budget', async () => {
    process.env['SUDO_KAIROS_REPAIR_MAX_PER_DAY'] = '1';
    process.env['SUDO_KAIROS_REPAIR_DEMAND_ONLY'] = '1';
    await triggerKAIROSRepair(OBS_A, 'refactor');
    delete process.env['SUDO_KAIROS_REPAIR_DEMAND_ONLY'];
    delete process.env['SUDO_KAIROS_REPAIR_MAX_PER_DAY'];
    // After the flag flips back, the same observation is still NEW and the
    // full budget is still available.
    expect(isNewKairosObservation(OBS_A, 'refactor')).toBe(true);
    expect(consumeKairosRepairBudget().used).toBe(1);
  });
});
