/**
 * @file skill-bench.ts
 * @description Skill condition benchmark wrapper for SUDO-AI.
 *
 * Runs the same task set under 4 SkillConditions:
 *   - no_skills:             no skills loaded
 *   - skills_on:             skills loaded, unoptimized
 *   - skills_optimized:      skills loaded with optimization
 *   - skills_post_optimizer: skills loaded with SkillOptimizer-approved proposals
 *
 * Emits a Markdown report comparing performance across conditions.
 * Re-uses BenchRunner for the actual sweep logic.
 *
 * @note skills_post_optimizer produces differentiated results ONLY after at least one
 * sleep cycle has run with a wired SkillOptimizer AND at least one proposal has been
 * approved via POST /v1/admin/skills/optimizations/:id/approve. On a fresh deploy with no
 * approved proposals, this condition falls back to skills_on behavior transparently.
 * This is expected and documented behavior.
 */

import { createLogger } from '../shared/logger.js';
import type { BenchReport, BenchTask, SkillCondition } from '../shared/wave10-types.js';
import { BenchRunner, type BrainCallable } from './bench-runner.js';
import { BenchStore } from './bench-store.js';

const log = createLogger('eval:skill-bench');

const ALL_CONDITIONS: SkillCondition[] = [
  'no_skills',
  'skills_on',
  'skills_optimized',
  'skills_post_optimizer',
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SkillBenchOptions {
  /** Models to evaluate (at least one required). */
  models: string[];
  /** Agent identifier label. Defaults to "default". */
  agentId?: string;
  /** Task IDs to run — empty/omitted runs all 5 built-in tasks. */
  taskIds?: string[];
  /** Number of random seeds per cell. Defaults to 1. */
  seeds?: number;
  /** Brain callable for actual model calls. Optional — omit for dry-run. */
  brain?: BrainCallable;
  /** BenchStore for persisting results. */
  store: BenchStore;
  /**
   * Optional — if absent, skills_post_optimizer behaves identically to skills_on.
   * Provide the SkillOptimizer (or any duck-typed object with getApprovedForSkill).
   */
  skillOptimizer?: {
    getApprovedForSkill(skillId: string): { proposedValue: string; targetField: string } | null;
  };
  /** Optional task override forwarded to BenchRunner. When set, `taskIds` is ignored. */
  tasks?: BenchTask[];
  /** Optional brain-strategy label forwarded to BenchRunner. Defaults to 'single'. */
  strategy?: string;
}

// ---------------------------------------------------------------------------
// SkillBenchResult
// ---------------------------------------------------------------------------

export interface SkillBenchResult {
  /** Full BenchReport from the sweep. */
  report: BenchReport;
  /** Markdown report comparing the 4 conditions. */
  markdownReport: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConditionComparisonTable(report: BenchReport): string {
  const lines: string[] = [
    '## Skill Condition Comparison',
    '',
    '| Condition | Success Rate | Median Latency (ms) |',
    '|-----------|-------------|---------------------|',
  ];

  for (const cond of ALL_CONDITIONS) {
    const stats = report.byCondition[cond] ?? { successRate: 0, medianLatencyMs: 0 };
    lines.push(
      `| ${cond} | ${(stats.successRate * 100).toFixed(1)}% | ${stats.medianLatencyMs.toFixed(0)} |`,
    );
  }

  // Find best condition by success rate
  const best = ALL_CONDITIONS.reduce((prev, cur) => {
    const ps = report.byCondition[prev]?.successRate ?? 0;
    const cs = report.byCondition[cur]?.successRate ?? 0;
    return cs > ps ? cur : prev;
  });

  lines.push('', `**Best condition:** \`${best}\``);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the skill benchmark across all 3 conditions and return results + report.
 *
 * Internally delegates to BenchRunner — this is a thin orchestration wrapper
 * that sets conditions to all 3 and builds the comparison table.
 */
export async function runSkillBench(opts: SkillBenchOptions): Promise<SkillBenchResult> {
  const { models, agentId = 'default', taskIds, seeds = 1, brain, store, skillOptimizer, tasks, strategy } = opts;

  log.info({ models, seeds }, 'SkillBench: starting 4-condition sweep');

  const runner = new BenchRunner(store);
  const report = await runner.run({
    models,
    agentId,
    taskIds,
    conditions: ALL_CONDITIONS,
    seeds,
    brain,
    store,
    skillOptimizer,
    ...(tasks ? { tasks } : {}),
    ...(strategy ? { strategy } : {}),
  });

  const conditionTable = buildConditionComparisonTable(report);
  const markdownReport = [
    conditionTable,
    '',
    '---',
    '',
    report.markdownSummary,
  ].join('\n');

  log.info({ runId: report.runId, successRate: report.successRate }, 'SkillBench: sweep complete');

  return { report, markdownReport };
}
