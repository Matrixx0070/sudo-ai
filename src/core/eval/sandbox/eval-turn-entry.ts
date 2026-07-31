/**
 * @file eval-turn-entry.ts
 * @description Child-process entry for one eval-sandbox agent turn (ADR-0007).
 * Spawned by eval-runner.ts with the SCRUBBED env only: DATA_DIR points at the
 * run's private data/ dir, so every DB the bootstrap opens is run-local.
 * Bootstrap mirrors bootstrapRealAgentLoop (agent-bench-runner.ts:204) but
 * honours the injected DATA_DIR instead of the fixed bench dir, arms the eval
 * gate, and runs the turn as UNTRUSTED (caller.isOwner=false) so tool exec
 * lands in the Docker fail-closed sandbox tier (Spec 8).
 *
 * Writes {text, steps, usd?, error?} to $SUDO_EVAL_RESULT and exits 0 whenever
 * a result was produced; the parent treats a missing result file as a crash.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateEvalGate } from './eval-gate.js';
import { RunJournal } from './run-journal.js';
import type { Scenario } from './scenario.js';

async function main(): Promise<void> {
  const scenarioPath = requireEnv('SUDO_EVAL_SCENARIO');
  const journalPath = requireEnv('SUDO_EVAL_JOURNAL');
  const resultPath = requireEnv('SUDO_EVAL_RESULT');
  const workspaceDir = requireEnv('SUDO_EVAL_WORKSPACE');
  const dataDir = requireEnv('DATA_DIR');
  const maxSteps = Math.max(1, Number(process.env['SUDO_EVAL_MAX_STEPS'] ?? '10'));

  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8')) as Scenario;

  activateEvalGate({
    runId: process.env['SUDO_EVAL_RUN_ID'] ?? 'unknown',
    policy: scenario.policy ?? {},
    journal: new RunJournal(journalPath),
  });

  // --- bootstrap (mirrors agent-bench-runner.ts bootstrapRealAgentLoop) ---
  const { ConfigLoader } = await import('../../config/loader.js');
  const configLoader = new ConfigLoader();
  await configLoader.load();
  const config = configLoader.get();

  const mindDbPath = path.join(dataDir, 'mind.db');
  const { getCostTracker } = await import('../../billing/cost-tracker.js');
  const costTracker = getCostTracker(mindDbPath);

  const { Brain } = await import('../../brain/brain.js');
  const brain = new Brain(config);

  const { ToolRegistry } = await import('../../tools/registry.js');
  const { loadBuiltinTools } = await import('../../tools/loader.js');
  const registry = new ToolRegistry();
  ToolRegistry.setGlobal(registry);
  const toolsDir = new URL('../../tools/builtin', import.meta.url).pathname;
  await loadBuiltinTools(registry, toolsDir);

  const { MindDB } = await import('../../memory/db.js');
  const { SessionManager } = await import('../../sessions/manager.js');
  const db = new MindDB(mindDbPath);
  const sessionMgr = new SessionManager(db);

  const { AgentLoop } = await import('../../agent/loop.js');
  const sandboxManager = {
    getWorkspaceDir: () => workspaceDir,
    getPolicyFor: () => ({
      readonly: false,
      allowedPaths: [dataDir, workspaceDir, os.tmpdir()],
    }),
  };
  const agentLoop = new AgentLoop(
    brain,
    registry,
    sessionMgr,
    { maxIterations: maxSteps },
    undefined, undefined, undefined, undefined,
    sandboxManager,
  );

  const session = await sessionMgr.getOrCreate('web', `eval-${process.env['SUDO_EVAL_RUN_ID']}`);
  const sessionId = String(session.id);

  let steps = 0;
  const onEvent = (event: { type: string }): void => {
    if (event.type === 'tool-call') steps += 1;
  };

  const costBefore = costTracker.getTodayCost().total;
  const out: { text: string; steps: number; usd?: number; error?: string } = { text: '', steps: 0 };
  try {
    const result = await (agentLoop as unknown as {
      run(
        sessionId: string,
        message: string,
        onEvent?: (e: { type: string }) => void,
        opts?: { caller?: { isOwner?: boolean; channel?: string } },
      ): Promise<{ text: string }>;
    }).run(sessionId, scenario.prompt, onEvent, {
      caller: { isOwner: false, channel: 'eval' },
    });
    out.text = typeof result.text === 'string' ? result.text : '';
  } catch (err) {
    out.error = String(err).slice(0, 500);
  }
  out.steps = steps;
  out.usd = Math.max(0, costTracker.getTodayCost().total - costBefore);

  fs.writeFileSync(resultPath, JSON.stringify(out, null, 2));
  process.exit(0);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`eval-turn-entry: missing env ${name}`);
  return v;
}

main().catch((err) => {
  console.error('eval-turn-entry fatal:', err);
  process.exit(1);
});
