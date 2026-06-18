/**
 * @file bench-matrix.ts
 * @description BenchMatrix — measures the impact of brain execution strategies
 * (single / debate / tree-search) by running the SAME task set once per strategy
 * and comparing the results.
 *
 * The question it answers: "does debate / tree-search actually beat single, and
 * at what cost?" Each strategy run yields a {@link RunSummary} (reusing the
 * regression engine's roll-up); the matrix lays them side by side with deltas
 * versus a baseline strategy and names a winner.
 *
 * Two layers, mirroring bench-regression / eval-gate:
 *   - pure aggregation (buildStrategyMatrix, renderStrategyMatrixMarkdown) —
 *     deterministic, fully unit-tested, no I/O or LLM.
 *   - live orchestration (runStrategyMatrix) — binds each strategy into a
 *     BrainCallable that forwards `{ strategy }` to brain.call and accumulates
 *     cost, runs BenchRunner per strategy, reads results back from the store.
 *
 * Why a strategy-bound BrainCallable: BenchRunner's own `strategy` field is only
 * a LABEL — it does not change the brain call. Real strategy impact only shows
 * when `brain.call(req, { strategy })` is actually invoked, and per-call cost
 * (BenchRunner hardcodes row cost to 0) is captured from `brain.usage`.
 */

import { summarizeRun, type RunSummary } from './bench-regression.js';
import { BenchRunner, type BrainCallable } from './bench-runner.js';
import type { BenchStore } from './bench-store.js';
import { BUILTIN_TASKS } from './task-set.js';
import type { BenchResult, BenchTask, SkillCondition } from '../shared/wave10-types.js';

// ---------------------------------------------------------------------------
// Matrix types
// ---------------------------------------------------------------------------

/** One strategy's roll-up within the matrix. */
export interface StrategyCell {
  strategy: string;
  summary: RunSummary;
}

/** A non-baseline strategy's deltas versus the baseline strategy. */
export interface StrategyDelta {
  strategy: string;
  /** current.passRate - baseline.passRate (signed fraction). */
  passRateDelta: number;
  /** current.meanScore - baseline.meanScore. */
  meanScoreDelta: number;
  /** current.totalCost / baseline.totalCost — the "3× cost" figure. null when baseline cost is 0. */
  costRatio: number | null;
  /** current.totalLatency / baseline.totalLatency. null when baseline latency is 0. */
  latencyRatio: number | null;
}

/** Full side-by-side comparison of strategies over one task set. */
export interface StrategyMatrix {
  baselineStrategy: string;
  /** Baseline cell first, then the rest by pass-rate desc (meanScore, name as tiebreaks). */
  cells: StrategyCell[];
  /** Deltas for every non-baseline strategy. */
  deltas: StrategyDelta[];
  /** Strategy with the best quality/cost trade-off (see pickWinner). */
  winner: string;
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

/** One strategy's raw run input to the matrix. */
export interface StrategyRun {
  strategy: string;
  results: BenchResult[];
  /** Explicit total cost (USD) for this strategy run — overrides the rows' cost (which BenchRunner leaves 0). */
  totalCostUsd?: number;
}

/**
 * Aggregate per-strategy runs into a comparison matrix. Pure — deterministic for
 * the same inputs. The baseline defaults to 'single', or the first run's strategy
 * when 'single' is absent.
 */
export function buildStrategyMatrix(
  runs: StrategyRun[],
  opts: { baselineStrategy?: string } = {},
): StrategyMatrix {
  if (runs.length === 0) {
    throw new Error('buildStrategyMatrix: at least one strategy run is required');
  }

  const cells: StrategyCell[] = runs.map(r => ({
    strategy: r.strategy,
    summary: summaryWithCost(summarizeRun(r.strategy, r.results, r.strategy), r.totalCostUsd),
  }));

  const cellByStrategy = new Map(cells.map(c => [c.strategy, c]));
  const baselineStrategy = opts.baselineStrategy
    ?? (cellByStrategy.has('single') ? 'single' : cells[0]!.strategy);
  const baseline = cellByStrategy.get(baselineStrategy) ?? cells[0]!;

  // Order: baseline first, then by pass-rate desc → meanScore desc → name.
  const rest = cells
    .filter(c => c.strategy !== baseline.strategy)
    .sort((a, b) =>
      b.summary.passRate - a.summary.passRate ||
      b.summary.meanScore - a.summary.meanScore ||
      (a.strategy < b.strategy ? -1 : a.strategy > b.strategy ? 1 : 0),
    );
  const ordered = [baseline, ...rest];

  const deltas: StrategyDelta[] = rest.map(c => ({
    strategy: c.strategy,
    passRateDelta: c.summary.passRate - baseline.summary.passRate,
    meanScoreDelta: c.summary.meanScore - baseline.summary.meanScore,
    costRatio: baseline.summary.totalCostUsd > 0
      ? c.summary.totalCostUsd / baseline.summary.totalCostUsd
      : null,
    latencyRatio: baseline.summary.totalLatencyMs > 0
      ? c.summary.totalLatencyMs / baseline.summary.totalLatencyMs
      : null,
  }));

  return {
    baselineStrategy: baseline.strategy,
    cells: ordered,
    deltas,
    winner: pickWinner(cells, baseline.strategy),
  };
}

/**
 * Pick the winning strategy: highest pass-rate, ties broken by mean-score, then
 * by LOWEST total cost (quality being equal, cheaper wins), then the baseline,
 * then name. This rewards a strategy only when it's at least as good AND cheaper.
 */
function pickWinner(cells: StrategyCell[], baselineStrategy: string): string {
  const sorted = [...cells].sort((a, b) =>
    b.summary.passRate - a.summary.passRate ||
    b.summary.meanScore - a.summary.meanScore ||
    a.summary.totalCostUsd - b.summary.totalCostUsd ||
    (a.strategy === baselineStrategy ? -1 : b.strategy === baselineStrategy ? 1 : 0) ||
    (a.strategy < b.strategy ? -1 : a.strategy > b.strategy ? 1 : 0),
  );
  return sorted[0]!.strategy;
}

/** Return a copy of the summary with totalCostUsd overridden and passesPerDollar recomputed. */
function summaryWithCost(summary: RunSummary, totalCostUsd?: number): RunSummary {
  if (totalCostUsd === undefined) return summary;
  return {
    ...summary,
    totalCostUsd,
    passesPerDollar: totalCostUsd > 0 ? summary.passed / totalCostUsd : 0,
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/** Render a StrategyMatrix as a Markdown report. Deterministic. */
export function renderStrategyMatrixMarkdown(matrix: StrategyMatrix): string {
  const lines: string[] = [
    `## Strategy Matrix — baseline \`${matrix.baselineStrategy}\``,
    '',
    '| Strategy | Pass rate | Mean score | Tasks | Total cost | Passes / $ | Passes / min |',
    '|----------|-----------|-----------|-------|------------|-----------|-------------|',
  ];

  for (const cell of matrix.cells) {
    const s = cell.summary;
    const tag = cell.strategy === matrix.baselineStrategy ? ' _(baseline)_' : '';
    const win = cell.strategy === matrix.winner ? ' 🏆' : '';
    lines.push(
      `| \`${cell.strategy}\`${tag}${win} | ${pct(s.passRate)} | ${s.meanScore.toFixed(3)} | ` +
      `${s.passed}/${s.total} | $${s.totalCostUsd.toFixed(4)} | ${s.passesPerDollar.toFixed(2)} | ${s.passesPerMinute.toFixed(2)} |`,
    );
  }

  if (matrix.deltas.length > 0) {
    lines.push(
      '',
      `### Δ vs baseline \`${matrix.baselineStrategy}\``,
      '',
      '| Strategy | Pass-rate Δ | Mean-score Δ | Cost × | Latency × |',
      '|----------|-------------|--------------|--------|-----------|',
    );
    for (const d of matrix.deltas) {
      lines.push(
        `| \`${d.strategy}\` | ${signedPts(d.passRateDelta)} | ${signedNum(d.meanScoreDelta, 3)} | ` +
        `${ratio(d.costRatio)} | ${ratio(d.latencyRatio)} |`,
      );
    }
  }

  const winnerDelta = matrix.deltas.find(d => d.strategy === matrix.winner);
  const summary = winnerDelta
    ? `**Winner: \`${matrix.winner}\`** — ${signedPts(winnerDelta.passRateDelta)} pass-rate vs baseline at ${ratio(winnerDelta.costRatio)} cost.`
    : `**Winner: \`${matrix.winner}\`** (baseline held its ground).`;
  lines.push('', summary);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Live orchestration
// ---------------------------------------------------------------------------

/** Minimal structural view of the real Brain needed by the matrix. */
export interface StrategyBrain {
  call(
    request: { source?: string; messages: Array<{ role: string; content: string }>; model: string },
    opts?: { strategy?: string },
  ): Promise<{ content: string; usage?: { estimatedCost?: number } }>;
}

export interface StrategyMatrixRunOptions {
  brain: StrategyBrain;
  /** Strategies to compare, e.g. ['single', 'debate', 'tree-search']. */
  strategies: string[];
  /** Models to sweep (passed through to BenchRunner). At least one. */
  models: string[];
  store: BenchStore;
  /** Tasks to run. Defaults to the built-in task set. */
  tasks?: BenchTask[];
  /** Seeds per task × model × condition. Default 1. */
  seeds?: number;
  /** Conditions to sweep. Default BenchRunner's default (all four). */
  conditions?: SkillCondition[];
  /** Baseline strategy for deltas. Default 'single' (or first strategy). */
  baselineStrategy?: string;
}

/**
 * Run the task set once per strategy and build the comparison matrix. Each
 * strategy runs through a BrainCallable that forwards `{ strategy }` to the real
 * brain and accumulates per-call estimated cost.
 */
export async function runStrategyMatrix(opts: StrategyMatrixRunOptions): Promise<StrategyMatrix> {
  if (opts.strategies.length === 0) {
    throw new Error('runStrategyMatrix: at least one strategy is required');
  }
  const tasks = opts.tasks ?? BUILTIN_TASKS;
  const runs: StrategyRun[] = [];

  for (const strategy of opts.strategies) {
    let cost = 0;
    const adapter: BrainCallable = {
      call: async (o) => {
        const resp = await opts.brain.call(
          { source: o.source ?? 'eval-matrix', messages: o.messages, model: o.model },
          { strategy },
        );
        cost += resp.usage?.estimatedCost ?? 0;
        return { content: resp.content };
      },
    };

    const runner = new BenchRunner(opts.store);
    const report = await runner.run({
      models: opts.models,
      store: opts.store,
      tasks,
      brain: adapter,
      strategy,
      ...(opts.seeds !== undefined ? { seeds: opts.seeds } : {}),
      ...(opts.conditions !== undefined ? { conditions: opts.conditions } : {}),
    });

    const results = opts.store.listResults({ runId: report.runId, limit: 100_000 });
    runs.push({ strategy, results, totalCostUsd: cost });
  }

  const matrixOpts = opts.baselineStrategy !== undefined
    ? { baselineStrategy: opts.baselineStrategy }
    : {};
  return buildStrategyMatrix(runs, matrixOpts);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function signedPts(deltaFraction: number): string {
  return signedNum(deltaFraction * 100, 1) + ' pts';
}

function signedNum(n: number, digits: number): string {
  const v = n.toFixed(digits);
  return n > 0 ? `+${v}` : v;
}

function ratio(r: number | null): string {
  return r === null ? 'n/a' : `${r.toFixed(2)}×`;
}
