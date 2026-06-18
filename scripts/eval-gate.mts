#!/usr/bin/env tsx
// scripts/eval-gate.mts
//
// CI gate driver: compare a current benchmark run against a committed baseline
// and fail (exit 1) on regression. Pure orchestration over src/core/eval/
// eval-gate.ts — running the actual evals happens upstream (the bench runners /
// scripts/agent-bench-run.mts), this script only weighs their JSON output.
//
// Usage:
//   # Gate a current run (BenchResult[] JSON) against the baseline
//   tsx scripts/eval-gate.mts --current results.json --baseline eval-baselines/agent.json
//
//   # Current run is agent-bench-run.mts output (AgentBenchResult[] shape)
//   tsx scripts/eval-gate.mts --current results.json --baseline eval-baselines/agent.json --from-agent
//
//   # Capture / refresh the baseline from a known-good run (exit 0, no gating)
//   tsx scripts/eval-gate.mts --current results.json --baseline eval-baselines/agent.json --update-baseline
//
//   # Write the markdown report to a file (for the workflow to post as a PR comment)
//   tsx scripts/eval-gate.mts --current results.json --baseline b.json --output report.md
//
// Thresholds are read from the environment (see parseGateThresholdsFromEnv):
//   EVAL_GATE_MAX_PASS_RATE_DROP, EVAL_GATE_MAX_COST_INCREASE_PCT,
//   EVAL_GATE_MAX_LATENCY_INCREASE_PCT, EVAL_GATE_FAIL_ON_TASK_REGRESSION=0
//
// Exit codes: 0 = pass / baseline established, 1 = regression, 2 = usage/IO error.

import fs from 'node:fs';
import {
  loadBaseline,
  saveBaseline,
  runGate,
  summarizeRun,
  agentResultsToBenchResults,
  parseGateThresholdsFromEnv,
  type AgentResultLike,
} from '../src/core/eval/eval-gate.js';
import type { BenchResult } from '../src/core/shared/wave10-types.js';

interface Args {
  current?: string;
  baseline?: string;
  output?: string;
  runId?: string;
  label?: string;
  fromAgent: boolean;
  updateBaseline: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { fromAgent: false, updateBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--current':         args.current = argv[++i]; break;
      case '--baseline':        args.baseline = argv[++i]; break;
      case '--output':          args.output = argv[++i]; break;
      case '--run-id':          args.runId = argv[++i]; break;
      case '--label':           args.label = argv[++i]; break;
      case '--from-agent':      args.fromAgent = true; break;
      case '--update-baseline': args.updateBaseline = true; break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function readJson(file: string): unknown {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args.current) { console.error('error: --current <results.json> is required'); return 2; }
  if (!args.baseline) { console.error('error: --baseline <baseline.json> is required'); return 2; }

  const runId = args.runId ?? `run-${new Date().toISOString()}`;
  const label = args.label ?? runId;

  const parsed = readJson(args.current);
  if (!Array.isArray(parsed)) { console.error('error: --current must contain a JSON array'); return 2; }

  const rows: BenchResult[] = args.fromAgent
    ? agentResultsToBenchResults(parsed as AgentResultLike[], runId)
    : (parsed as BenchResult[]);

  const current = summarizeRun(runId, rows, label);

  if (args.updateBaseline) {
    saveBaseline(args.baseline, current, new Date().toISOString());
    console.error(`[eval-gate] baseline written to ${args.baseline} (${current.passed}/${current.total} passing)`);
    return 0;
  }

  const baseline = loadBaseline(args.baseline);
  const thresholds = parseGateThresholdsFromEnv(process.env);
  const outcome = runGate({ baseline, current, thresholds });

  if (args.output) {
    fs.writeFileSync(args.output, outcome.markdown + '\n', 'utf8');
    console.error(`[eval-gate] report written to ${args.output}`);
  }
  // Markdown to stdout so the report is always visible in the CI log too.
  console.log(outcome.markdown);

  if (outcome.baselineMissing) {
    console.error('[eval-gate] no baseline found — run with --update-baseline to establish one. Passing.');
  } else if (outcome.exitCode !== 0) {
    console.error(`[eval-gate] REGRESSION: ${outcome.verdict!.reasons.join('; ')}`);
  } else {
    console.error('[eval-gate] PASS');
  }
  return outcome.exitCode;
}

try {
  process.exit(main());
} catch (err) {
  console.error('[eval-gate] error:', err instanceof Error ? err.message : String(err));
  process.exit(2);
}
