#!/usr/bin/env tsx
// scripts/agent-bench-divide.mts
//
// One-shot end-to-end runner for the divide-bug agentic benchmark. Spins up a
// real AgentLoop (via AgentBenchRunner default bootstrap) and asks the agent
// to fix /workspace/divide.py so the held-out pytest suite passes.
//
// Run with tsx so it loads src/ directly (the esbuild bundle is a single
// dist/server/cli.js — no per-file tree to import from).
//
//   pnpm exec tsx scripts/agent-bench-divide.mts
//   AGENT_BENCH_KEEP_WORKSPACE=1 pnpm exec tsx scripts/...
//   AGENT_BENCH_MODEL=claude-oauth/claude-sonnet-4-5 pnpm exec tsx scripts/...
//
// Exits 0 on PASS, 1 on FAIL, 2 on bootstrap/runtime error.

import { AgentBenchRunner } from '../src/core/eval/agent-bench-runner.js';
import { divideBugTask } from '../src/core/eval/agent-tasks/divide-bug.js';

async function main(): Promise<number> {
  const model = process.env['AGENT_BENCH_MODEL'] ?? 'claude-oauth/claude-sonnet-4-5';
  const runner = new AgentBenchRunner({ bootstrap: { modelOverride: model } });
  const keep = process.env['AGENT_BENCH_KEEP_WORKSPACE'] === '1';

  console.error('[agent-bench-divide] starting run, model =', model);
  const result = await runner.run(divideBugTask, { keepWorkspace: keep });

  console.log(JSON.stringify({
    taskId:         result.taskId,
    model:          result.model,
    passed:         result.passed,
    score:          result.score,
    detail:         result.detail.slice(0, 800),
    wallTimeMs:     result.wallTimeMs,
    toolCallCount:  result.toolCallCount,
    transcriptHash: result.transcriptHash,
    agentTextLen:   result.agentText.length,
    startedAt:      result.startedAt,
  }, null, 2));

  return result.passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[agent-bench-divide] error:', err);
    process.exit(2);
  },
);
