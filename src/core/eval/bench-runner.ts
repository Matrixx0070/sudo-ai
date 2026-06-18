/**
 * @file bench-runner.ts
 * @description Model × agent × task sweep engine for SUDO-AI benchmarks.
 *
 * BenchRunner orchestrates evaluation across:
 *   - Multiple models
 *   - Multiple tasks (from task-set.ts)
 *   - Multiple SkillConditions (no_skills / skills_on / skills_optimized)
 *   - Multiple random seeds
 *
 * Returns a BenchReport with aggregated statistics and a Markdown summary.
 * All I/O is isolated to BenchStore — BenchRunner itself is side-effect-free
 * apart from writing to the store and invoking the brain callable.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type { BenchResult, BenchReport, BenchTask, SkillCondition } from '../shared/wave10-types.js';
import { scoreComplexity } from '../agent/complexity-scorer.js';
import { BenchStore } from './bench-store.js';
import { getBuiltinTasks } from './task-set.js';

const log = createLogger('eval:bench-runner');

// ---------------------------------------------------------------------------
// Duck-typed brain interface used by the runner
// ---------------------------------------------------------------------------

export interface BrainCallable {
  /**
   * Call the model and return the response text.
   * Should throw on hard errors; resolution failure counts as success=false.
   */
  call(opts: { messages: Array<{ role: string; content: string }>; model: string }): Promise<{ content: string }>;
}

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

export interface BenchRunOptions {
  /** Models to sweep. Required — at least one entry. */
  models: string[];
  /** Agent identifier label attached to all results. */
  agentId?: string;
  /** Task IDs to run. Empty/omitted → all 5 built-in tasks. */
  taskIds?: string[];
  /** Skill conditions to sweep. Defaults to all 4 conditions. */
  conditions?: SkillCondition[];
  /** Number of random seeds per task × model × condition. Defaults to 1. */
  seeds?: number;
  /** Optional brain callable; if omitted results are synthetic (all success=false, latency=0). */
  brain?: BrainCallable;
  /** BenchStore instance. Required — caller must provide. */
  store: BenchStore;
  /**
   * Optional — if absent, skills_post_optimizer behaves identically to skills_on.
   * Meaningful results only after >= 1 sleep cycle has run with a wired SkillOptimizer
   * AND at least one proposal has been approved via POST /v1/admin/skills/optimizations/:id/approve.
   */
  skillOptimizer?: {
    getApprovedForSkill(skillId: string): { proposedValue: string; targetField: string } | null;
  };
  /**
   * Optional task override. When provided, BenchRunner uses these tasks instead of the
   * built-in set. `taskIds` is ignored when this is set. Required for tests that need to
   * exercise the runner without coupling to built-in task verifiers.
   */
  tasks?: BenchTask[];
  /**
   * Optional brain-strategy label recorded on every BenchResult ('single' | 'debate' | 'tree-search' | custom).
   * Defaults to 'single'. Does not change runner behavior — purely a tag for downstream slicing.
   */
  strategy?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_CONDITIONS: SkillCondition[] = [
  'no_skills',
  'skills_on',
  'skills_optimized',
  'skills_post_optimizer',
];

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function p99(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * 0.99) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

/**
 * Evaluate one task × model × condition × seed. Returns a BenchResult.
 *
 * For condition 'skills_post_optimizer': if skillOptimizer is provided and returns an
 * approved proposal for this task, the prompt is augmented with the proposed optimization.
 * If skillOptimizer is absent or returns null (no approved proposals yet), falls back to
 * skills_on behavior transparently (D7 — fail-open on fresh deploys).
 *
 * @note skills_post_optimizer produces differentiated results ONLY after at least one
 * sleep cycle has run SkillOptimizer AND at least one proposal has been approved.
 */
async function runOne(
  runId: string,
  task: BenchTask,
  model: string,
  agentId: string,
  condition: SkillCondition,
  seedIndex: number,
  strategy: string,
  brain?: BrainCallable,
  skillOptimizer?: {
    getApprovedForSkill(skillId: string): { proposedValue: string; targetField: string } | null;
  },
): Promise<BenchResult> {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const wallStart = Date.now();

  // Determine the effective prompt for this condition.
  // skills_post_optimizer: augment prompt with approved proposal if available;
  // otherwise fall back to skills_on behavior (same original prompt).
  let effectivePrompt = task.prompt;
  if (condition === 'skills_post_optimizer' && skillOptimizer) {
    try {
      const approved = skillOptimizer.getApprovedForSkill(task.id);
      if (approved) {
        effectivePrompt =
          `${task.prompt}\n\n[Optimizer suggestion — ${approved.targetField}: ${approved.proposedValue}]`;
        log.debug(
          { taskId: task.id, targetField: approved.targetField },
          'BenchRunner: applied SkillOptimizer proposal to prompt',
        );
      }
      // If null → fall through with original prompt (skills_on parity)
    } catch (err: unknown) {
      // Fail-open: if reading the proposal throws, use original prompt (D7)
      log.warn(
        { err: String(err), taskId: task.id },
        'BenchRunner: getApprovedForSkill threw — falling back to skills_on prompt (fail-open)',
      );
    }
  }

  // Complexity scoring on effective prompt
  const complexity = scoreComplexity({ prompt: effectivePrompt, modelName: model });

  let success = false;
  let score = 0;
  let verifierType = 'legacy';
  let verifierDetail = 'no brain response';
  let latencyMs = 0;
  const costUsd = 0; // Cost estimation is delegated to brain; default 0
  let responseContent = '';

  if (brain) {
    const t0 = Date.now();
    try {
      const resp = await brain.call({
        messages: [{ role: 'user', content: effectivePrompt }],
        model,
      });
      latencyMs = Date.now() - t0;
      responseContent = typeof resp.content === 'string' ? resp.content : '';

      if (task.verifier) {
        try {
          const v = await task.verifier.verify(task, responseContent);
          success = v.passed;
          score = v.score;
          verifierType = v.type;
          verifierDetail = v.detail;
        } catch (verErr) {
          log.warn({ err: String(verErr), taskId: task.id }, 'Verifier threw — counted as failure');
          success = false;
          score = 0;
          verifierType = task.verifier.type;
          verifierDetail = `verifier error: ${String(verErr)}`;
        }
      } else {
        // Legacy non-empty-response check (pre-Phase 1 behavior).
        success = responseContent.trim().length > 0;
        score = success ? 1 : 0;
        verifierType = 'legacy';
        verifierDetail = success ? 'non-empty response' : 'empty response';
      }
    } catch (err) {
      latencyMs = Date.now() - t0;
      log.warn({ err: String(err), taskId: task.id, model, condition }, 'Brain call failed — marking as failure');
      success = false;
      score = 0;
      verifierType = task.verifier?.type ?? 'legacy';
      verifierDetail = `brain error: ${String(err)}`;
    }
  }

  const wallTimeMs = Date.now() - wallStart;
  const transcriptHash = responseContent.length > 0
    ? createHash('sha256').update(responseContent).digest('hex')
    : '';

  return {
    id,
    runId,
    model,
    agentId,
    taskId: task.id,
    condition,
    seedIndex,
    success,
    latencyMs,
    costUsd,
    complexityTier: complexity.tier,
    timestamp,
    score,
    verifierType,
    verifierDetail,
    strategy,
    wallTimeMs,
    transcriptHash,
  };
}

/** Build aggregated statistics from a flat result list. */
function aggregateResults(results: BenchResult[]): Omit<BenchReport, 'runId' | 'startedAt' | 'completedAt' | 'markdownSummary'> {
  const total = results.length;
  const successCount = results.filter(r => r.success).length;
  const successRate = total > 0 ? successCount / total : 0;

  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const medianLatencyMs = median(latencies);
  const p99LatencyMs = p99(latencies);
  const totalCostUsd = results.reduce((s, r) => s + r.costUsd, 0);

  // Per-condition aggregation
  const byCondition = {} as BenchReport['byCondition'];
  for (const cond of ALL_CONDITIONS) {
    const sub = results.filter(r => r.condition === cond);
    const subLatencies = sub.map(r => r.latencyMs).sort((a, b) => a - b);
    byCondition[cond] = {
      successRate: sub.length > 0 ? sub.filter(r => r.success).length / sub.length : 0,
      medianLatencyMs: median(subLatencies),
    };
  }

  // Per-model aggregation
  const modelIds = [...new Set(results.map(r => r.model))];
  const byModel = {} as BenchReport['byModel'];
  for (const m of modelIds) {
    const sub = results.filter(r => r.model === m);
    const subLatencies = sub.map(r => r.latencyMs).sort((a, b) => a - b);
    byModel[m] = {
      successRate: sub.length > 0 ? sub.filter(r => r.success).length / sub.length : 0,
      medianLatencyMs: median(subLatencies),
    };
  }

  return { totalTasks: total, successRate, medianLatencyMs, p99LatencyMs, totalCostUsd, byCondition, byModel };
}

/** Generate a Markdown summary table from aggregated stats. */
function buildMarkdownSummary(report: Omit<BenchReport, 'markdownSummary'>): string {
  const lines: string[] = [
    `## Benchmark Report — Run \`${report.runId}\``,
    '',
    `- **Started:** ${report.startedAt}`,
    `- **Completed:** ${report.completedAt}`,
    `- **Total evaluations:** ${report.totalTasks}`,
    `- **Overall success rate:** ${(report.successRate * 100).toFixed(1)}%`,
    `- **Median latency:** ${report.medianLatencyMs.toFixed(0)} ms`,
    `- **p99 latency:** ${report.p99LatencyMs.toFixed(0)} ms`,
    `- **Total cost:** $${report.totalCostUsd.toFixed(4)}`,
    '',
    '### By Condition',
    '',
    '| Condition | Success Rate | Median Latency |',
    '|-----------|-------------|----------------|',
    ...ALL_CONDITIONS.map(c => {
      const s = report.byCondition[c];
      return `| ${c} | ${(s.successRate * 100).toFixed(1)}% | ${s.medianLatencyMs.toFixed(0)} ms |`;
    }),
    '',
    '### By Model',
    '',
    '| Model | Success Rate | Median Latency |',
    '|-------|-------------|----------------|',
    ...Object.entries(report.byModel).map(([m, s]) =>
      `| ${m} | ${(s.successRate * 100).toFixed(1)}% | ${s.medianLatencyMs.toFixed(0)} ms |`
    ),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class BenchRunner {
  private readonly store: BenchStore;

  constructor(store: BenchStore) {
    this.store = store;
  }

  /**
   * Run a full sweep and return the completed BenchReport.
   * Results are persisted to the store; report is upserted after completion.
   */
  async run(opts: BenchRunOptions): Promise<BenchReport> {
    const {
      models,
      agentId = 'default',
      taskIds,
      conditions = ALL_CONDITIONS,
      seeds = 1,
      brain,
      skillOptimizer,
      tasks: tasksOverride,
      strategy = 'single',
    } = opts;

    if (!models || models.length === 0) {
      throw new Error('BenchRunner.run: models array must not be empty');
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();

    log.info({ runId, models, conditions, seeds, strategy }, 'BenchRunner: starting sweep');

    const tasks = tasksOverride && tasksOverride.length > 0 ? tasksOverride : getBuiltinTasks(taskIds);
    const allResults: BenchResult[] = [];

    for (const model of models) {
      for (const task of tasks) {
        for (const condition of conditions) {
          for (let si = 0; si < seeds; si++) {
            const result = await runOne(runId, task, model, agentId, condition, si, strategy, brain, skillOptimizer);
            allResults.push(result);
          }
        }
      }
    }

    // Persist results in a single batch transaction
    this.store.insertResults(allResults);

    const completedAt = new Date().toISOString();
    const stats = aggregateResults(allResults);
    const reportBase = { runId, startedAt, completedAt, ...stats };
    const markdownSummary = buildMarkdownSummary(reportBase);
    const report: BenchReport = { ...reportBase, markdownSummary };

    this.store.upsertReport(report);
    log.info({ runId, totalTasks: report.totalTasks, successRate: report.successRate }, 'BenchRunner: sweep complete');

    return report;
  }
}
