#!/usr/bin/env tsx
// scripts/bench-matrix.mts
//
// Measure brain-strategy impact: run the built-in bench task set once per
// strategy (single / debate / tree-search) and print a comparison matrix —
// per-strategy pass-rate, mean-score, cost, passes/$ — plus deltas vs a baseline
// and a winner. Answers "does debate / tree-search beat single, at what cost?"
//
// Usage:
//   # Compare single vs debate over the built-in tasks
//   BENCH_MATRIX_STRATEGIES=single,debate pnpm eval:matrix
//
//   # All three strategies, pin a model, write the report to a file
//   BENCH_MATRIX_STRATEGIES=single,debate,tree-search \
//   BENCH_MATRIX_MODEL=claude-oauth/claude-opus-4-8 \
//   BENCH_MATRIX_OUT=matrix.md pnpm eval:matrix
//
// Env:
//   BENCH_MATRIX_STRATEGIES  comma list (default "single,debate")
//   BENCH_MATRIX_MODEL       model id (default config intelligence.default_model)
//   BENCH_MATRIX_BASELINE    baseline strategy for deltas (default "single")
//   BENCH_MATRIX_OUT         write the markdown report to this file
//   BENCH_MATRIX_CONDITION   skill condition to sweep (default "no_skills")
//
// Exits 0 on success, 2 on bootstrap/config error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runStrategyMatrix,
  renderStrategyMatrixMarkdown,
  type StrategyBrain,
} from '../src/core/eval/bench-matrix.js';
import type { BrainMessage } from '../src/core/brain/types.js';
import type { SkillCondition } from '../src/core/shared/wave10-types.js';

async function main(): Promise<number> {
  const strategies = (process.env['BENCH_MATRIX_STRATEGIES'] ?? 'single,debate')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (strategies.length === 0) {
    console.error('error: BENCH_MATRIX_STRATEGIES resolved to no strategies');
    return 2;
  }
  const baseline = process.env['BENCH_MATRIX_BASELINE'] ?? 'single';
  const condition = (process.env['BENCH_MATRIX_CONDITION'] ?? 'no_skills') as SkillCondition;

  // Isolated DATA_DIR so the bench's DBs don't collide with the pm2 daemon.
  const benchDataDir = path.join(process.env['HOME'] ?? '/root', '.sudo-ai', 'bench-data');
  fs.mkdirSync(benchDataDir, { recursive: true });
  process.env['DATA_DIR'] = benchDataDir;

  const { ConfigLoader } = await import('../src/core/config/loader.js');
  const configLoader = new ConfigLoader();
  await configLoader.load();
  const config = configLoader.get();

  const { Brain } = await import('../src/core/brain/brain.js');
  const brain = new Brain(config);

  const model = process.env['BENCH_MATRIX_MODEL']
    ?? (config as { intelligence?: { default_model?: string } })?.intelligence?.default_model
    ?? 'unknown';

  const { BenchStore } = await import('../src/core/eval/bench-store.js');
  const store = new BenchStore(path.join(benchDataDir, 'bench-matrix.db'));

  // Adapt the real Brain to the matrix's minimal StrategyBrain. BenchRunner only
  // ever sends role:'user' messages, so the role coercion is safe.
  const strategyBrain: StrategyBrain = {
    async call(request, opts) {
      const resp = await brain.call(
        { messages: request.messages as BrainMessage[], model: request.model },
        { strategy: opts?.strategy, source: request.source ?? 'eval-matrix' },
      );
      return { content: resp.content, usage: { estimatedCost: resp.usage?.estimatedCost } };
    },
  };

  console.error(`[bench-matrix] model=${model} strategies=${strategies.join(',')} baseline=${baseline}`);

  const matrix = await runStrategyMatrix({
    brain: strategyBrain,
    strategies,
    models: [model],
    store,
    conditions: [condition],
    seeds: 1,
    baselineStrategy: baseline,
  });

  const md = renderStrategyMatrixMarkdown(matrix);
  const outFile = process.env['BENCH_MATRIX_OUT'];
  if (outFile) {
    fs.writeFileSync(outFile, md + '\n', 'utf8');
    console.error(`[bench-matrix] report written to ${outFile}`);
  }
  console.log(md);
  console.error(`[bench-matrix] winner=${matrix.winner}`);

  store.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[bench-matrix] error:', err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
