/**
 * @file bench-regression.ts
 * @description Deterministic regression-comparison engine for benchmark runs.
 *
 * This is the load-bearing piece of the eval-as-CI-gate work: it turns two sets
 * of {@link BenchResult} rows (a stored baseline and a fresh run) into a
 * {@link RegressionVerdict} and a Markdown PR-comment report. It is PURE — no
 * I/O, no LLM calls, no clock — so the gate decision is fully unit-testable and
 * reproducible. Running the actual evals (which needs API keys) is a separate
 * concern; this module only weighs the results.
 *
 * Headline metrics beyond raw pass-rate:
 *   - passesPerDollar  — accepted tasks per USD spent (efficiency vs cost)
 *   - passesPerMinute  — accepted tasks per minute of wall-clock (efficiency vs time)
 *
 * Gate policy (default): a run regresses if ANY task flips pass→fail, or the
 * overall pass-rate drops at all. Cost and latency are reported but not gated
 * unless the caller supplies thresholds — quality should never silently degrade,
 * but a cheaper/slower run is a judgment call left to the operator.
 */

import type { BenchResult } from '../shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Summary types
// ---------------------------------------------------------------------------

/** Per-task roll-up within a single run. One row per distinct taskId. */
export interface TaskSummary {
  taskId: string;
  /** True if the task is considered passed (any seed succeeded → pass; see summarizeRun). */
  passed: boolean;
  /** Mean score in [0, 1] across this task's result rows. */
  score: number;
  /** Sum of per-row cost in USD for this task. */
  costUsd: number;
  /** Sum of per-row latency in ms for this task. */
  latencyMs: number;
  /** Number of result rows (seeds) that contributed to this summary. */
  seedCount: number;
}

/** Aggregated, derived view of one benchmark run. */
export interface RunSummary {
  runId: string;
  /** Optional human label (model id, strategy, git sha) for report headers. */
  label?: string;
  /** Per-task roll-ups, sorted by taskId for stable output. */
  tasks: TaskSummary[];
  /** Distinct task count. */
  total: number;
  /** Number of tasks whose `passed` is true. */
  passed: number;
  /** passed / total, 0 when total is 0. */
  passRate: number;
  /** Mean of per-task scores, 0 when total is 0. */
  meanScore: number;
  /** Sum of all per-row costs in USD. */
  totalCostUsd: number;
  /** Sum of all per-row latencies in ms. */
  totalLatencyMs: number;
  /** Accepted tasks per USD. 0 when cost is 0 (avoids Infinity). */
  passesPerDollar: number;
  /** Accepted tasks per minute of wall-clock. 0 when time is 0. */
  passesPerMinute: number;
}

// ---------------------------------------------------------------------------
// Verdict types
// ---------------------------------------------------------------------------

/** How a single task changed between baseline and current. */
export type TaskFlip = 'regressed' | 'fixed' | 'unchanged' | 'added' | 'removed';

/** Per-task delta between the two runs. */
export interface TaskDelta {
  taskId: string;
  /** null when the task is absent from the baseline (added). */
  baselinePassed: boolean | null;
  /** null when the task is absent from the current run (removed). */
  currentPassed: boolean | null;
  flip: TaskFlip;
  /** current.score - baseline.score; 0 when either side is absent. */
  scoreDelta: number;
}

/** Thresholds that turn cost / latency growth into gate failures. */
export interface RegressionThresholds {
  /**
   * Max tolerated absolute drop in pass-rate (fraction, 0..1) before it counts as
   * a regression. Default 0 — any drop fails.
   */
  maxPassRateDrop?: number;
  /**
   * Max tolerated increase in total cost, as a fraction (0.1 = +10%). Default
   * undefined — cost is reported but never gates.
   */
  maxCostIncreasePct?: number;
  /**
   * Max tolerated increase in total latency, as a fraction. Default undefined —
   * latency is reported but never gates.
   */
  maxLatencyIncreasePct?: number;
  /**
   * When true, a single pass→fail task flip is a regression even if the overall
   * pass-rate holds (a fixed task masking a broken one). Default true.
   */
  failOnAnyTaskRegression?: boolean;
}

/** Full comparison outcome. */
export interface RegressionVerdict {
  baseline: RunSummary;
  current: RunSummary;
  /** current.passRate - baseline.passRate (signed fraction). */
  passRateDelta: number;
  /** Fractional change in total cost; null when baseline cost is 0. */
  costDeltaPct: number | null;
  /** Fractional change in total latency; null when baseline latency is 0. */
  latencyDeltaPct: number | null;
  /** Per-task deltas, sorted by taskId. */
  taskDeltas: TaskDelta[];
  /** taskIds that flipped pass→fail. */
  regressedTasks: string[];
  /** taskIds that flipped fail→pass. */
  fixedTasks: string[];
  /** True when the gate should fail. */
  isRegression: boolean;
  /** Human-readable reasons the gate failed (empty when it passed). */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// summarizeRun
// ---------------------------------------------------------------------------

/**
 * Roll a flat list of BenchResult rows up into a derived RunSummary.
 *
 * Multiple rows can share a taskId (one per seed). A task is `passed` when at
 * least one of its rows succeeded — the optimistic convention, matching "the
 * agent can solve this task". Score is the mean across seeds. `success` is the
 * source of truth for pass/fail; `score` falls back to 1.0/0.0 from `success`
 * when a row carries no verifier score.
 */
export function summarizeRun(
  runId: string,
  results: BenchResult[],
  label?: string,
): RunSummary {
  const byTask = new Map<string, BenchResult[]>();
  for (const r of results) {
    const arr = byTask.get(r.taskId);
    if (arr) arr.push(r);
    else byTask.set(r.taskId, [r]);
  }

  const tasks: TaskSummary[] = [];
  for (const [taskId, rows] of byTask) {
    const passed = rows.some(r => r.success);
    const scoreSum = rows.reduce((s, r) => s + rowScore(r), 0);
    tasks.push({
      taskId,
      passed,
      score: rows.length > 0 ? scoreSum / rows.length : 0,
      costUsd: rows.reduce((s, r) => s + (r.costUsd || 0), 0),
      latencyMs: rows.reduce((s, r) => s + (r.latencyMs || 0), 0),
      seedCount: rows.length,
    });
  }
  tasks.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));

  const total = tasks.length;
  const passedCount = tasks.filter(t => t.passed).length;
  const totalCostUsd = tasks.reduce((s, t) => s + t.costUsd, 0);
  const totalLatencyMs = tasks.reduce((s, t) => s + t.latencyMs, 0);
  const minutes = totalLatencyMs / 60_000;

  return {
    runId,
    label,
    tasks,
    total,
    passed: passedCount,
    passRate: total > 0 ? passedCount / total : 0,
    meanScore: total > 0 ? tasks.reduce((s, t) => s + t.score, 0) / total : 0,
    totalCostUsd,
    totalLatencyMs,
    passesPerDollar: totalCostUsd > 0 ? passedCount / totalCostUsd : 0,
    passesPerMinute: minutes > 0 ? passedCount / minutes : 0,
  };
}

/** Score for one row: explicit verifier score if present, else 1/0 from success. */
function rowScore(r: BenchResult): number {
  if (typeof r.score === 'number' && Number.isFinite(r.score)) {
    return clamp01(r.score);
  }
  return r.success ? 1 : 0;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// ---------------------------------------------------------------------------
// compareRuns
// ---------------------------------------------------------------------------

/**
 * Compare a current run against a baseline and decide whether it regressed.
 * Pure: same inputs always yield the same verdict.
 */
export function compareRuns(
  baseline: RunSummary,
  current: RunSummary,
  thresholds: RegressionThresholds = {},
): RegressionVerdict {
  const {
    maxPassRateDrop = 0,
    maxCostIncreasePct,
    maxLatencyIncreasePct,
    failOnAnyTaskRegression = true,
  } = thresholds;

  const baseByTask = new Map(baseline.tasks.map(t => [t.taskId, t]));
  const curByTask = new Map(current.tasks.map(t => [t.taskId, t]));
  const allIds = [...new Set([...baseByTask.keys(), ...curByTask.keys()])].sort();

  const taskDeltas: TaskDelta[] = [];
  const regressedTasks: string[] = [];
  const fixedTasks: string[] = [];

  for (const taskId of allIds) {
    const b = baseByTask.get(taskId);
    const c = curByTask.get(taskId);
    const baselinePassed = b ? b.passed : null;
    const currentPassed = c ? c.passed : null;

    let flip: TaskFlip;
    if (b && c) {
      if (b.passed && !c.passed) { flip = 'regressed'; regressedTasks.push(taskId); }
      else if (!b.passed && c.passed) { flip = 'fixed'; fixedTasks.push(taskId); }
      else flip = 'unchanged';
    } else if (!b && c) {
      flip = 'added';
    } else {
      flip = 'removed';
    }

    const scoreDelta = b && c ? c.score - b.score : 0;
    taskDeltas.push({ taskId, baselinePassed, currentPassed, flip, scoreDelta });
  }

  const passRateDelta = current.passRate - baseline.passRate;
  const costDeltaPct = baseline.totalCostUsd > 0
    ? (current.totalCostUsd - baseline.totalCostUsd) / baseline.totalCostUsd
    : null;
  const latencyDeltaPct = baseline.totalLatencyMs > 0
    ? (current.totalLatencyMs - baseline.totalLatencyMs) / baseline.totalLatencyMs
    : null;

  const reasons: string[] = [];

  if (passRateDelta < -maxPassRateDrop) {
    reasons.push(
      `Pass-rate dropped ${(passRateDelta * 100).toFixed(1)} pts ` +
      `(${pct(baseline.passRate)} → ${pct(current.passRate)})`,
    );
  }
  if (failOnAnyTaskRegression && regressedTasks.length > 0) {
    reasons.push(
      `${regressedTasks.length} task(s) regressed pass→fail: ${regressedTasks.join(', ')}`,
    );
  }
  if (maxCostIncreasePct !== undefined && costDeltaPct !== null && costDeltaPct > maxCostIncreasePct) {
    reasons.push(
      `Cost rose ${(costDeltaPct * 100).toFixed(1)}% (limit ${(maxCostIncreasePct * 100).toFixed(1)}%)`,
    );
  }
  if (maxLatencyIncreasePct !== undefined && latencyDeltaPct !== null && latencyDeltaPct > maxLatencyIncreasePct) {
    reasons.push(
      `Latency rose ${(latencyDeltaPct * 100).toFixed(1)}% (limit ${(maxLatencyIncreasePct * 100).toFixed(1)}%)`,
    );
  }

  return {
    baseline,
    current,
    passRateDelta,
    costDeltaPct,
    latencyDeltaPct,
    taskDeltas,
    regressedTasks,
    fixedTasks,
    isRegression: reasons.length > 0,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// renderRegressionMarkdown
// ---------------------------------------------------------------------------

/**
 * Render a RegressionVerdict as a Markdown PR comment. Deterministic — safe to
 * diff in tests and to post idempotently.
 */
export function renderRegressionMarkdown(verdict: RegressionVerdict): string {
  const { baseline: b, current: c } = verdict;
  const status = verdict.isRegression ? '🔴 REGRESSION' : '🟢 PASS';

  const lines: string[] = [
    `## Eval Gate — ${status}`,
    '',
    `Baseline \`${b.label ?? b.runId}\` → Current \`${c.label ?? c.runId}\``,
    '',
    '| Metric | Baseline | Current | Δ |',
    '|--------|----------|---------|---|',
    `| Pass rate | ${pct(b.passRate)} | ${pct(c.passRate)} | ${signedPts(verdict.passRateDelta)} |`,
    `| Tasks passed | ${b.passed}/${b.total} | ${c.passed}/${c.total} | ${signedInt(c.passed - b.passed)} |`,
    `| Mean score | ${b.meanScore.toFixed(3)} | ${c.meanScore.toFixed(3)} | ${signedNum(c.meanScore - b.meanScore, 3)} |`,
    `| Total cost | $${b.totalCostUsd.toFixed(4)} | $${c.totalCostUsd.toFixed(4)} | ${pctOrNa(verdict.costDeltaPct)} |`,
    `| Passes / $ | ${b.passesPerDollar.toFixed(2)} | ${c.passesPerDollar.toFixed(2)} | ${signedNum(c.passesPerDollar - b.passesPerDollar, 2)} |`,
    `| Passes / min | ${b.passesPerMinute.toFixed(2)} | ${c.passesPerMinute.toFixed(2)} | ${signedNum(c.passesPerMinute - b.passesPerMinute, 2)} |`,
  ];

  if (verdict.reasons.length > 0) {
    lines.push('', '### Why this failed', '');
    for (const reason of verdict.reasons) lines.push(`- ${reason}`);
  }

  if (verdict.regressedTasks.length > 0) {
    lines.push('', '### ❌ Regressed (pass → fail)', '');
    for (const id of verdict.regressedTasks) lines.push(`- \`${id}\``);
  }
  if (verdict.fixedTasks.length > 0) {
    lines.push('', '### ✅ Fixed (fail → pass)', '');
    for (const id of verdict.fixedTasks) lines.push(`- \`${id}\``);
  }

  const added = verdict.taskDeltas.filter(d => d.flip === 'added').map(d => d.taskId);
  const removed = verdict.taskDeltas.filter(d => d.flip === 'removed').map(d => d.taskId);
  if (added.length > 0) {
    lines.push('', `### ➕ New tasks (not in baseline)`, '');
    for (const id of added) lines.push(`- \`${id}\``);
  }
  if (removed.length > 0) {
    lines.push('', `### ➖ Removed tasks (not in current run)`, '');
    for (const id of removed) lines.push(`- \`${id}\``);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function pctOrNa(fraction: number | null): string {
  return fraction === null ? 'n/a' : signedNum(fraction * 100, 1) + '%';
}

function signedPts(deltaFraction: number): string {
  return signedNum(deltaFraction * 100, 1) + ' pts';
}

function signedInt(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function signedNum(n: number, digits: number): string {
  const v = n.toFixed(digits);
  return n > 0 ? `+${v}` : v;
}
