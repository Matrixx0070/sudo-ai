/**
 * @file eval-gate.ts
 * @description Orchestration layer that turns the pure {@link bench-regression}
 * engine into a runnable CI gate. Handles the I/O-and-policy glue that the
 * comparison engine deliberately omits:
 *
 *   - load / save a committed baseline RunSummary (JSON on disk)
 *   - normalise heterogeneous run outputs (BenchResult rows OR AgentBenchResult
 *     rows from the Phase-2 agent runner) into a single comparable shape
 *   - parse gate thresholds from the environment
 *   - decide an exit code (0 pass / 1 regression) and render the PR comment
 *
 * Everything here is deterministic and unit-tested. The actual eval *execution*
 * (which needs API keys) lives in the bench runners + scripts/eval-gate.mts; the
 * GitHub Actions workflow chains runner → this gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  summarizeRun,
  compareRuns,
  renderRegressionMarkdown,
  type RunSummary,
  type RegressionVerdict,
  type RegressionThresholds,
} from './bench-regression.js';
import type { BenchResult } from '../shared/wave10-types.js';

/** On-disk baseline format. Self-contained — stores the derived summary, not raw rows. */
export const BASELINE_VERSION = 1 as const;

export interface BaselineFile {
  version: number;
  /** ISO-8601 timestamp the baseline was captured. */
  savedAt: string;
  summary: RunSummary;
}

/** Result of evaluating a current run against a baseline. */
export interface GateOutcome {
  /** The comparison verdict, or null when there was no baseline to compare against. */
  verdict: RegressionVerdict | null;
  /** Markdown report suitable for a PR comment. */
  markdown: string;
  /** Process exit code: 0 = pass / no-baseline, 1 = regression. */
  exitCode: number;
  /** True when no baseline existed — the run establishes one rather than gating. */
  baselineMissing: boolean;
}

// ---------------------------------------------------------------------------
// Baseline persistence
// ---------------------------------------------------------------------------

/**
 * Read a baseline RunSummary from disk. Returns null — never throws — when the
 * file is absent, unreadable, or malformed, so a first run (no baseline yet)
 * degrades to "establish a baseline" rather than crashing the gate.
 */
export function loadBaseline(filePath: string): RunSummary | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null; // ENOENT etc. — no baseline yet
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BaselineFile>;
    if (!parsed || typeof parsed !== 'object' || !parsed.summary) return null;
    const s = parsed.summary as RunSummary;
    if (!Array.isArray(s.tasks) || typeof s.passRate !== 'number') return null;
    return s;
  } catch {
    return null; // malformed JSON — treat as no baseline
  }
}

/** Write a baseline RunSummary to disk (creates parent dirs; atomic via tmp+rename). */
export function saveBaseline(filePath: string, summary: RunSummary, savedAtIso: string): void {
  const payload: BaselineFile = { version: BASELINE_VERSION, savedAt: savedAtIso, summary };
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

/**
 * A loose superset of the fields the Phase-2 agent runner emits per task. Cost
 * is intentionally optional — the agent runner does not yet track per-run cost,
 * so passesPerDollar will be 0 for agent suites until it does.
 */
export interface AgentResultLike {
  taskId: string;
  passed: boolean;
  score?: number;
  model?: string;
  wallTimeMs?: number;
  costUsd?: number;
  transcriptHash?: string;
  startedAt?: string;
}

/**
 * Map agent-runner outputs onto BenchResult rows so the regression engine can
 * consume them uniformly. Defaults fill the fields the agent runner does not
 * report (condition, complexity tier, cost).
 */
export function agentResultsToBenchResults(results: AgentResultLike[], runId: string): BenchResult[] {
  return results.map((r, i) => ({
    id: r.transcriptHash ? `${r.taskId}-${r.transcriptHash.slice(0, 8)}` : `${r.taskId}-${i}`,
    runId,
    model: r.model ?? 'unknown',
    agentId: 'agent-bench',
    taskId: r.taskId,
    condition: 'no_skills',
    seedIndex: 0,
    success: r.passed,
    latencyMs: r.wallTimeMs ?? 0,
    costUsd: r.costUsd ?? 0,
    complexityTier: 'simple',
    timestamp: r.startedAt ?? '',
    score: typeof r.score === 'number' ? r.score : (r.passed ? 1 : 0),
    verifierType: 'exec',
    transcriptHash: r.transcriptHash,
  }));
}

// ---------------------------------------------------------------------------
// Threshold parsing
// ---------------------------------------------------------------------------

/** Build RegressionThresholds from environment variables. All optional. */
export function parseGateThresholdsFromEnv(env: Record<string, string | undefined>): RegressionThresholds {
  const out: RegressionThresholds = {};
  const drop = numEnv(env['EVAL_GATE_MAX_PASS_RATE_DROP']);
  if (drop !== undefined) out.maxPassRateDrop = drop;
  const cost = numEnv(env['EVAL_GATE_MAX_COST_INCREASE_PCT']);
  if (cost !== undefined) out.maxCostIncreasePct = cost;
  const latency = numEnv(env['EVAL_GATE_MAX_LATENCY_INCREASE_PCT']);
  if (latency !== undefined) out.maxLatencyIncreasePct = latency;
  // Default ON; explicit "0" / "false" disables the per-task-flip rule.
  const flip = env['EVAL_GATE_FAIL_ON_TASK_REGRESSION'];
  if (flip === '0' || flip === 'false') out.failOnAnyTaskRegression = false;
  return out;
}

function numEnv(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Compare a current run against a baseline and produce a gate outcome. When the
 * baseline is null, the run passes (exit 0) and the markdown announces a new
 * baseline rather than a comparison.
 */
export function runGate(opts: {
  baseline: RunSummary | null;
  current: RunSummary;
  thresholds?: RegressionThresholds;
}): GateOutcome {
  const { baseline, current, thresholds } = opts;

  if (!baseline) {
    return {
      verdict: null,
      markdown: renderNoBaselineMarkdown(current),
      exitCode: 0,
      baselineMissing: true,
    };
  }

  const verdict = compareRuns(baseline, current, thresholds);
  return {
    verdict,
    markdown: renderRegressionMarkdown(verdict),
    exitCode: verdict.isRegression ? 1 : 0,
    baselineMissing: false,
  };
}

/** Markdown for the first run, when there is nothing to compare against. */
function renderNoBaselineMarkdown(current: RunSummary): string {
  return [
    '## Eval Gate — 🟡 NO BASELINE',
    '',
    `No baseline found — establishing one from \`${current.label ?? current.runId}\`.`,
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Tasks passed | ${current.passed}/${current.total} |`,
    `| Pass rate | ${(current.passRate * 100).toFixed(1)}% |`,
    `| Mean score | ${current.meanScore.toFixed(3)} |`,
    `| Total cost | $${current.totalCostUsd.toFixed(4)} |`,
    `| Passes / $ | ${current.passesPerDollar.toFixed(2)} |`,
    `| Passes / min | ${current.passesPerMinute.toFixed(2)} |`,
  ].join('\n');
}

// Re-export the building blocks so callers can import everything from the gate.
export { summarizeRun, compareRuns, renderRegressionMarkdown };
export type { RunSummary, RegressionVerdict, RegressionThresholds };
