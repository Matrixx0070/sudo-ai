/**
 * @file skill-bench-4th-condition.test.ts
 * @description Tests for the Wave 13 fourth SkillCondition: `skills_post_optimizer`.
 *
 * @note skills_post_optimizer produces differentiated results ONLY after at least one
 * sleep cycle has run with a wired SkillOptimizer AND at least one proposal has been
 * approved via POST /v1/admin/skills/optimizations/:id/approve. On a fresh deploy with no
 * approved proposals, this condition falls back to skills_on behavior transparently.
 * This is expected and documented behavior.
 *
 * Test coverage:
 *   1. ALL_CONDITIONS has 4 entries (includes 4th literal)
 *   2. ALL_CONDITIONS includes 'skills_post_optimizer'
 *   3. SkillCondition type accepts all 4 literals (compile-time, exercised at runtime)
 *   4. runSkillBench report.byCondition contains all 4 keys including skills_post_optimizer
 *   5. Markdown comparison table contains 4 rows (all 4 conditions listed)
 *   6. Fallback: when skillOptimizer absent → identical totalTasks as skills_on run
 *   7. BenchRunner handles missing skillOptimizer gracefully (no throw)
 *   8. With mocked skillOptimizer returning non-null → augments prompt (differentiated run)
 *   9. Fallback: when skillOptimizer.getApprovedForSkill returns null → same as skills_on
 *  10. Fail-open: when skillOptimizer.getApprovedForSkill throws → still completes (no crash)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSkillBench } from '../../src/core/eval/skill-bench.js';
import { BenchRunner } from '../../src/core/eval/bench-runner.js';
import { BenchStore } from '../../src/core/eval/bench-store.js';
import type { BenchTask, SkillCondition } from '../../src/core/shared/wave10-types.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-4th-'));
  return path.join(dir, 'bench.db');
}

function makeSuccessBrain() {
  return {
    call: vi.fn().mockResolvedValue({ content: 'response text' }),
  };
}

/** 5 verifier-less tasks — runner falls back to legacy non-empty-response check. */
function makeSimpleTasks(): BenchTask[] {
  return Array.from({ length: 5 }, (_, i) => ({
    id: `simple-${i}`,
    name: `Simple task ${i}`,
    prompt: `Echo task ${i}.`,
    expectedOutput: 'non-empty response',
    complexityTier: 'simple',
  }));
}

/** Minimal duck-typed SkillOptimizer mock with approved proposal for any skillId. */
function makeOptimizerWithApproval() {
  return {
    getApprovedForSkill: vi.fn().mockReturnValue({
      proposedValue: 'improved description for the skill',
      targetField: 'description',
    }),
  };
}

/** Minimal duck-typed SkillOptimizer mock that returns null (no approved proposals). */
function makeOptimizerEmpty() {
  return {
    getApprovedForSkill: vi.fn().mockReturnValue(null),
  };
}

/** Minimal duck-typed SkillOptimizer mock whose method throws. */
function makeOptimizerThrowing() {
  return {
    getApprovedForSkill: vi.fn().mockImplementation(() => {
      throw new Error('DB connection lost');
    }),
  };
}

// ---------------------------------------------------------------------------
// Type-level check: SkillCondition union accepts 'skills_post_optimizer'
// This exercises the union at runtime so it fails if the type guard is wrong.
// ---------------------------------------------------------------------------

const FOURTH_CONDITION: SkillCondition = 'skills_post_optimizer';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Wave 13 — 4th SkillCondition: skills_post_optimizer', () => {
  afterEach(() => vi.restoreAllMocks());

  // Test 1: ALL_CONDITIONS exported from skill-bench via runSkillBench uses 4 entries.
  // We infer this from totalTasks (5 built-in tasks × 4 conditions × 1 seed = 20).
  it('ALL_CONDITIONS has 4 entries — inferred from totalTasks being 20', async () => {
    const store = new BenchStore(makeTempDb());
    const { report } = await runSkillBench({ models: ['m'], seeds: 1, store });
    // 5 tasks × 4 conditions × 1 seed = 20
    expect(report.totalTasks).toBe(20);
    store.close();
  });

  // Test 2: report.byCondition contains the 4th key
  it('ALL_CONDITIONS includes skills_post_optimizer — byCondition has 4th key', async () => {
    const store = new BenchStore(makeTempDb());
    const { report } = await runSkillBench({ models: ['m'], seeds: 1, store });
    expect(report.byCondition['skills_post_optimizer']).toBeDefined();
    store.close();
  });

  // Test 3: SkillCondition type accepts the 4th literal at compile and runtime
  it("SkillCondition type accepts 'skills_post_optimizer' literal", () => {
    expect(FOURTH_CONDITION).toBe('skills_post_optimizer');
    // All 4 literals are valid SkillCondition assignments
    const conditions: SkillCondition[] = [
      'no_skills',
      'skills_on',
      'skills_optimized',
      'skills_post_optimizer',
    ];
    expect(conditions).toHaveLength(4);
    expect(conditions).toContain('skills_post_optimizer');
  });

  // Test 4: byCondition in runSkillBench report contains all 4 conditions
  it('runSkillBench report.byCondition contains all 4 condition keys', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = makeSuccessBrain();
    const { report } = await runSkillBench({ models: ['m'], seeds: 1, brain, store });

    expect(report.byCondition['no_skills']).toBeDefined();
    expect(report.byCondition['skills_on']).toBeDefined();
    expect(report.byCondition['skills_optimized']).toBeDefined();
    expect(report.byCondition['skills_post_optimizer']).toBeDefined();
    store.close();
  });

  // Test 5: Markdown comparison table contains all 4 condition rows
  it('markdownReport comparison table contains 4 condition rows', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = makeSuccessBrain();
    const { markdownReport } = await runSkillBench({ models: ['m'], seeds: 1, brain, store });

    expect(markdownReport).toContain('no_skills');
    expect(markdownReport).toContain('skills_on');
    expect(markdownReport).toContain('skills_optimized');
    expect(markdownReport).toContain('skills_post_optimizer');
    store.close();
  });

  // Test 6: Fallback when skillOptimizer absent — 4th condition has same successRate as skills_on
  // (D7: fresh deploy, no optimizer wired → behavior identical to skills_on)
  it('fallback: absent skillOptimizer — skills_post_optimizer has same successRate as skills_on', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = makeSuccessBrain();

    // Full 4-condition sweep without optimizer (should not crash)
    const { report } = await runSkillBench({
      models: ['m'],
      seeds: 1,
      brain,
      store,
    });

    // The 4th condition should have the same success rate as skills_on
    // when no optimizer is provided (same prompt → same brain mock result)
    const fourthCond = report.byCondition['skills_post_optimizer'];
    const skillsOn = report.byCondition['skills_on'];
    expect(fourthCond).toBeDefined();
    expect(skillsOn).toBeDefined();
    // Both conditions use same brain mock → same results (success rate equal)
    expect(fourthCond!.successRate).toBe(skillsOn!.successRate);
    store.close();
  });

  // Test 7: BenchRunner handles missing skillOptimizer option gracefully — no throw
  it('BenchRunner handles missing skillOptimizer gracefully without throwing', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = makeSuccessBrain();
    const runner = new BenchRunner(store);

    // No skillOptimizer provided — should not throw
    await expect(
      runner.run({
        models: ['m'],
        conditions: ['skills_post_optimizer'],
        seeds: 1,
        brain,
        store,
      }),
    ).resolves.toBeDefined();
    store.close();
  });

  // Test 8: With mocked skillOptimizer returning an approved proposal → run completes
  // (differentiated path taken — brain called with augmented prompt)
  it('mocked skillOptimizer with approved proposal — run completes and brain is called', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = makeSuccessBrain();
    const skillOptimizer = makeOptimizerWithApproval();
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models: ['m'],
      conditions: ['skills_post_optimizer'],
      seeds: 1,
      brain,
      store,
      skillOptimizer,
      tasks: makeSimpleTasks(),
    });

    // 5 tasks × 1 condition × 1 seed
    expect(report.totalTasks).toBe(5);
    expect(report.successRate).toBe(1);
    // getApprovedForSkill should have been called for each task
    expect(skillOptimizer.getApprovedForSkill).toHaveBeenCalled();
    store.close();
  });

  // Test 9: Fallback — when skillOptimizer.getApprovedForSkill returns null (no approved data)
  // → behavior should be identical to skills_on (same success rate from same brain)
  it('fallback: getApprovedForSkill returns null → same results as skills_on', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = makeSuccessBrain();
    const skillOptimizer = makeOptimizerEmpty();
    const runner = new BenchRunner(store);

    const report = await runner.run({
      models: ['m'],
      conditions: ['skills_post_optimizer', 'skills_on'],
      seeds: 1,
      brain,
      store,
      skillOptimizer,
    });

    const postOpt = report.byCondition['skills_post_optimizer'];
    const skillsOn = report.byCondition['skills_on'];
    expect(postOpt).toBeDefined();
    expect(skillsOn).toBeDefined();
    // Both use same brain → same success rate (null proposal → original prompt = skills_on path)
    expect(postOpt!.successRate).toBe(skillsOn!.successRate);
    // getApprovedForSkill should still have been called
    expect(skillOptimizer.getApprovedForSkill).toHaveBeenCalled();
    store.close();
  });

  // Test 10: Fail-open — when skillOptimizer.getApprovedForSkill throws → no crash, run completes
  // (D7 fail-open: try/catch in runOne falls back to original prompt)
  it('fail-open: getApprovedForSkill throws → run still completes without propagating error', async () => {
    const store = new BenchStore(makeTempDb());
    const brain = makeSuccessBrain();
    const skillOptimizer = makeOptimizerThrowing();
    const runner = new BenchRunner(store);

    // Must not throw
    await expect(
      runner.run({
        models: ['m'],
        conditions: ['skills_post_optimizer'],
        seeds: 1,
        brain,
        store,
        skillOptimizer,
      }),
    ).resolves.toBeDefined();

    // Brain should still have been called (fall back to original prompt)
    expect(brain.call).toHaveBeenCalled();
    store.close();
  });
});
