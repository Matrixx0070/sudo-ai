/**
 * @file builtin/bench.ts
 * @description /bench — run an eval sweep via BenchRunner and report results.
 *
 * Wave 10 Builder 2.
 *
 * Usage:
 *   /bench
 *   /bench models=grok,claude tasks=task-hello,task-arithmetic seeds=2
 *   /bench json
 *
 * The command starts a BenchRunner sweep using the builtin task set and the
 * currently-configured models (or a subset provided via args). Results are
 * formatted as a Markdown table and returned to the caller.
 *
 * The CommandContext agentLoop is expected to expose a compatible brain so
 * that BenchRunner can use it as a BrainCallable. If no brain is available,
 * the command runs in synthetic mode (all results recorded as failure).
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';
import { getBuiltinTasks } from '../../eval/task-set.js';
import type { BrainCallable } from '../../eval/bench-runner.js';

const log = createLogger('commands:bench');

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

/** Parse "key=value" pairs and bare flags from a space-separated args string. */
function parseArgs(raw: string): {
  models:     string[];
  taskIds:    string[];
  conditions: string[];
  seeds:      number;
  json:       boolean;
} {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const result = {
    models:     [] as string[],
    taskIds:    [] as string[],
    conditions: [] as string[],
    seeds:      1,
    json:       false,
  };

  for (const tok of tokens) {
    if (tok === 'json') { result.json = true; continue; }
    const eq = tok.indexOf('=');
    if (eq < 0) continue;
    const key = tok.slice(0, eq).toLowerCase();
    const val = tok.slice(eq + 1);
    switch (key) {
      case 'models':
        result.models = val.split(',').map(s => s.trim()).filter(Boolean);
        break;
      case 'tasks':
        result.taskIds = val.split(',').map(s => s.trim()).filter(Boolean);
        break;
      case 'conditions':
        result.conditions = val.split(',').map(s => s.trim()).filter(Boolean);
        break;
      case 'seeds':
        result.seeds = Math.max(1, parseInt(val, 10) || 1);
        break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Slash command implementation
// ---------------------------------------------------------------------------

export const benchCommand: SlashCommand = {
  name: 'bench',
  description: 'Run an eval sweep and return a Markdown summary. Args: models=, tasks=, seeds=, conditions=, json',
  usage: '/bench [models=grok,claude] [tasks=task-hello] [seeds=2] [conditions=no_skills] [json]',

  async execute(args: string, ctx: CommandContext): Promise<string> {
    log.debug({ args, sessionId: ctx.sessionId }, '/bench command invoked');

    const opts = parseArgs(args);

    // Resolve model list — fall back to config default
    let models = opts.models;
    if (models.length === 0) {
      const cfg = ctx.config as { defaultModel?: string; models?: string[] } | null;
      const fallback = cfg?.defaultModel ?? cfg?.models?.[0] ?? 'default';
      models = [fallback];
    }

    // Resolve tasks
    let tasks;
    try {
      tasks = getBuiltinTasks(opts.taskIds.length > 0 ? opts.taskIds : undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, '/bench: invalid task IDs');
      return `Error: ${msg}`;
    }

    if (tasks.length === 0) {
      return 'No tasks matched. Valid IDs: task-hello, task-arithmetic, task-code-review, task-pipeline-design, task-system-analysis.';
    }

    // Resolve conditions — default to all three
    const validConditions = ['no_skills', 'skills_on', 'skills_optimized'] as const;
    type ConditionType = typeof validConditions[number];
    const conditions: ConditionType[] = opts.conditions.length > 0
      ? (opts.conditions.filter(c => validConditions.includes(c as ConditionType)) as ConditionType[])
      : [...validConditions];

    if (conditions.length === 0) {
      return `Invalid conditions. Valid values: ${validConditions.join(', ')}`;
    }

    // Build a BrainCallable from the agentLoop if it exposes runWithModel
    const loop = ctx.agentLoop as {
      runWithModel?: (
        modelId: string,
        prompt: string,
        opts?: { maxTokens?: number },
      ) => Promise<{ content: string }>;
    } | null;

    let brain: BrainCallable | undefined;
    if (loop?.runWithModel) {
      brain = {
        async call(callOpts: { messages: Array<{ role: string; content: string }>; model: string }) {
          const prompt = callOpts.messages.map(m => m.content).join('\n');
          return loop.runWithModel!(callOpts.model, prompt, { maxTokens: 1024 });
        },
      };
    } else {
      log.warn({ sessionId: ctx.sessionId }, '/bench: agentLoop has no runWithModel — using synthetic mode');
    }

    // Dynamically import BenchRunner and BenchStore to avoid loading sqlite at boot
    let BenchRunner: typeof import('../../eval/bench-runner.js').BenchRunner;
    let BenchStore: typeof import('../../eval/bench-store.js').BenchStore;
    try {
      const [runnerMod, storeMod] = await Promise.all([
        import('../../eval/bench-runner.js'),
        import('../../eval/bench-store.js'),
      ]);
      BenchRunner = runnerMod.BenchRunner;
      BenchStore  = storeMod.BenchStore;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, '/bench: failed to import bench modules');
      return `Error importing bench module: ${msg}`;
    }

    // Use a temp SQLite file for the slash-command sweep (not the production store)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cmd-'));
    const store  = new BenchStore(path.join(tmpDir, 'bench.db'));

    try {
      const runner = new BenchRunner(store);
      log.info(
        { models, taskCount: tasks.length, conditions, seeds: opts.seeds },
        '/bench: starting sweep',
      );

      const report = await runner.run({
        models,
        taskIds:    opts.taskIds.length > 0 ? opts.taskIds : undefined,
        conditions,
        seeds:      opts.seeds,
        brain,
        store,
      });

      log.info(
        { runId: report.runId, successRate: report.successRate },
        '/bench: sweep complete',
      );

      if (opts.json) {
        return JSON.stringify(report, null, 2);
      }

      return report.markdownSummary;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, '/bench: sweep failed');
      return `Bench run failed: ${msg}`;
    } finally {
      try { store.close(); } catch { /* best-effort */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  },
};
