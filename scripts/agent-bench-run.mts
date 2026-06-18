#!/usr/bin/env tsx
// scripts/agent-bench-run.mts
//
// One-shot end-to-end runner for the agentic benchmark suite. Spins up a real
// AgentLoop (via AgentBenchRunner default bootstrap) and runs one or all tasks.
//
// Run with tsx so it loads src/ directly (the esbuild bundle is a single
// dist/server/cli.js — no per-file tree to import from).
//
//   # Default: run the divide-bug task with claude-opus-4-8
//   pnpm exec tsx scripts/agent-bench-divide.mts
//
//   # Pick a different task
//   AGENT_BENCH_TASK=agent-js-bug-fix pnpm exec tsx scripts/agent-bench-divide.mts
//
//   # Run the full suite
//   AGENT_BENCH_TASK=all pnpm exec tsx scripts/agent-bench-divide.mts
//
//   # Pin a model + keep workspace
//   AGENT_BENCH_MODEL=claude-oauth/claude-sonnet-4-6 \
//   AGENT_BENCH_KEEP_WORKSPACE=1 \
//   pnpm exec tsx scripts/agent-bench-divide.mts
//
// Exits 0 only if every task passed; 1 if any failed; 2 on bootstrap error.

import { AgentBenchRunner } from '../src/core/eval/agent-bench-runner.js';
import {
  AGENT_TASKS_BY_ID,
  ALL_AGENT_TASKS,
  divideBugTask,
} from '../src/core/eval/agent-tasks/index.js';
import type { AgentBenchTask } from '../src/core/eval/agent-bench-types.js';

function pickTasks(): AgentBenchTask[] {
  const id = process.env['AGENT_BENCH_TASK'];
  if (!id || id === '') return [divideBugTask];
  if (id === 'all') return ALL_AGENT_TASKS;
  const task = AGENT_TASKS_BY_ID[id];
  if (!task) {
    const known = Object.keys(AGENT_TASKS_BY_ID).join(', ');
    throw new Error(`Unknown AGENT_BENCH_TASK="${id}". Known: ${known}, or "all".`);
  }
  return [task];
}

async function main(): Promise<number> {
  const model = process.env['AGENT_BENCH_MODEL'] ?? 'claude-oauth/claude-opus-4-8';
  const runner = new AgentBenchRunner({ bootstrap: { modelOverride: model } });
  const keep = process.env['AGENT_BENCH_KEEP_WORKSPACE'] === '1';
  const tasks = pickTasks();

  console.error(`[agent-bench] model=${model} tasks=${tasks.map(t => t.id).join(',')}`);

  const results: Array<Record<string, unknown>> = [];
  let anyFailed = false;
  for (const task of tasks) {
    console.error(`[agent-bench] running ${task.id} …`);
    try {
      const r = await runner.run(task, { keepWorkspace: keep });
      results.push({
        taskId:         r.taskId,
        model:          r.model,
        passed:         r.passed,
        score:          r.score,
        detail:         r.detail.slice(0, 400),
        wallTimeMs:     r.wallTimeMs,
        toolCallCount:  r.toolCallCount,
        agentTextLen:   r.agentText.length,
      });
      if (!r.passed) anyFailed = true;
    } catch (err) {
      results.push({ taskId: task.id, error: String(err) });
      anyFailed = true;
    }
  }

  console.log(JSON.stringify(results, null, 2));
  return anyFailed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[agent-bench] error:', err);
    process.exit(2);
  },
);
