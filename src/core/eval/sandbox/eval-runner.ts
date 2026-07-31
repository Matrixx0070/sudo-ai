/**
 * @file eval-runner.ts
 * @description Orchestrates one eval-sandbox run (ADR-0007 Phase 1): run dir +
 * fixtures, scrubbed env, one agent turn, code-graded scoring into the journal
 * and BenchStore, then clean-state teardown.
 *
 * ISOLATION CHOICE (documented per spec): the agent turn runs in a CHILD
 * process (eval-turn-entry.ts via tsx), not in-process. AgentBenchRunner's
 * bootstrap sets the process-global DATA_DIR and module-level singletons
 * (ToolRegistry.setGlobal, cost-tracker), so an in-process run from a live
 * daemon or repeated runs in one process could not honestly claim clean state
 * — and an in-process child would inherit this process's full env (real
 * secrets) into system.exec. The child gets ONLY the scrubbed env
 * (env-scrub.ts) with DATA_DIR pointed at the run's private data/ dir.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../../shared/logger.js';
import { PROJECT_ROOT, dataPath } from '../../shared/paths.js';
import { BenchStore } from '../bench-store.js';
import type { BenchResult } from '../../shared/wave10-types.js';
import type { Scenario } from './scenario.js';
import { buildEvalEnv } from './env-scrub.js';
import { grade, type ScoreVector } from './graders.js';
import { startMockService, type MockServiceHandle } from './mock-service.js';
import { RunJournal, readJournal } from './run-journal.js';

const log = createLogger('eval:sandbox-runner');

// ---------------------------------------------------------------------------
// Turn executor seam (tests inject a stub; default spawns the tsx child)
// ---------------------------------------------------------------------------

export interface EvalTurnResult {
  text: string;
  steps: number;
  usd?: number;
  timedOut?: boolean;
  error?: string;
}

export interface TurnExecutorArgs {
  scenario: Scenario;
  runId: string;
  runDir: string;
  workspaceDir: string;
  dataDir: string;
  env: Record<string, string>;
  journalPath: string;
  prompt: string;
}

export type TurnExecutor = (args: TurnExecutorArgs) => Promise<EvalTurnResult>;

export interface EvalRunOptions {
  /** Keep the run's private data/ dir after the run (also SUDO_EVAL_KEEP_DATA=1). */
  keepData?: boolean;
  /** Injected turn executor for tests. Default: child-process tsx entry. */
  executor?: TurnExecutor;
  /** Bench DB path. Default: data/bench.db via dataPath(). */
  benchDbPath?: string;
  /** Root for run dirs. Default: <PROJECT_ROOT>/data/eval-runs. */
  evalRunsRoot?: string;
}

export interface EvalRunReport {
  runId: string;
  scenarioId: string;
  passed: boolean;
  scores: ScoreVector;
  journalPath: string;
  workspaceDir: string;
  turn: EvalTurnResult;
}

// ---------------------------------------------------------------------------
// Default executor: spawn the eval turn as a child process
// ---------------------------------------------------------------------------

const ENTRY = join(PROJECT_ROOT, 'src', 'core', 'eval', 'sandbox', 'eval-turn-entry.ts');

export const spawnTurnExecutor: TurnExecutor = (args) => {
  const resultPath = join(args.runDir, 'result.json');
  return new Promise((resolve) => {
    const child = spawn('node', ['--import', 'tsx', ENTRY], {
      cwd: PROJECT_ROOT,
      env: args.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 8_000).unref();
    }, args.scenario.budgets.maxWallMs);

    child.on('exit', (code) => {
      clearTimeout(killTimer);
      let parsed: Partial<EvalTurnResult> = {};
      try {
        if (existsSync(resultPath)) parsed = JSON.parse(readFileSync(resultPath, 'utf-8'));
      } catch { /* fall through to defaults */ }
      const out: EvalTurnResult = {
        text: typeof parsed.text === 'string' ? parsed.text : '',
        steps: typeof parsed.steps === 'number' ? parsed.steps : 0,
      };
      if (typeof parsed.usd === 'number') out.usd = parsed.usd;
      if (timedOut) { out.timedOut = true; out.error = `wall-clock budget exhausted (${args.scenario.budgets.maxWallMs}ms)`; }
      else if (code !== 0) out.error = parsed.error ?? `eval turn child exited ${code}`;
      else if (typeof parsed.error === 'string') out.error = parsed.error;
      resolve(out);
    });
  });
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runEval(scenario: Scenario, opts: EvalRunOptions = {}): Promise<EvalRunReport> {
  const runId = `${scenario.id}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const root = opts.evalRunsRoot ?? join(PROJECT_ROOT, 'data', 'eval-runs');
  const runDir = join(root, runId);
  const workspaceDir = join(runDir, 'workspace');
  const dataDir = join(runDir, 'data');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  for (const f of scenario.fixtures ?? []) {
    const p = join(workspaceDir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }

  // Clean state is the default; persistent memory is explicit + snapshot-seeded
  // (ADR-0007 invariant 1) and never the prod mind.db.
  if (scenario.persistentMemory !== undefined) {
    copyFileSync(scenario.persistentMemory, join(dataDir, 'mind.db'));
  }

  let mock: MockServiceHandle | null = null;
  if (scenario.mockService) mock = await startMockService(scenario.mockService);

  const prompt = scenario.prompt
    .replace(/\{workspace\}/g, workspaceDir)
    .replace(/\{mockServiceUrl\}/g, mock?.url ?? '');

  const journalPath = join(runDir, 'journal.jsonl');
  const journal = new RunJournal(journalPath);
  journal.append({ type: 'run.start', runId, scenarioId: scenario.id, scenarioVersion: scenario.version });
  journal.append({ type: 'prompt', text: prompt });

  // Child needs the manifest (policy for the in-child gate) — with the prompt
  // already substituted so placeholders never reach the model.
  const scenarioPath = join(runDir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify({ ...scenario, prompt }, null, 2));

  const extraEnv: Record<string, string> = {
    DATA_DIR: dataDir,
    SUDO_EVAL_RUN_ID: runId,
    SUDO_EVAL_SCENARIO: scenarioPath,
    SUDO_EVAL_JOURNAL: journalPath,
    SUDO_EVAL_RESULT: join(runDir, 'result.json'),
    SUDO_EVAL_WORKSPACE: workspaceDir,
    SUDO_EVAL_MAX_STEPS: String(scenario.budgets.maxSteps),
  };
  if (mock) extraEnv['MOCK_SERVICE_URL'] = mock.url;
  const env = buildEvalEnv(scenario, extraEnv);

  const executor = opts.executor ?? spawnTurnExecutor;
  const wallStart = Date.now();
  let turn: EvalTurnResult;
  try {
    turn = await executor({ scenario, runId, runDir, workspaceDir, dataDir, env, journalPath, prompt });
  } finally {
    if (mock) await mock.close();
  }
  // Budgets: maxWallMs enforced by the executor's kill timer; maxSteps by the
  // child's maxIterations. maxUsd is validated in the manifest but not
  // enforceable cheaply across the process boundary yet.
  // SCAFFOLD: Phase 2 — join the child's llm_calls rows for per-run USD enforcement.

  journal.append({
    type: 'run.end',
    ok: turn.error === undefined,
    output: turn.text,
    steps: turn.steps,
    ...(turn.error !== undefined ? { error: turn.error } : {}),
    ...(turn.timedOut ? { timedOut: true } : {}),
  });

  const events = readJournal(journalPath);
  const scores = await grade(scenario.grading.checks, {
    workspaceDir,
    output: turn.text,
    journal: events,
    canaries: scenario.policy?.canaryCredentials ?? [],
    env,
    wallMs: Date.now() - wallStart,
    steps: turn.steps,
    ...(turn.usd !== undefined ? { usd: turn.usd } : {}),
  });
  // A turn that errored or blew a budget is never a pass, whatever the checks say.
  if (turn.error !== undefined) scores.success = false;
  journal.append({ type: 'scores', ...scoresForJournal(scores) });

  persistToBench(scenario, runId, scores, turn, opts.benchDbPath);

  if (!(opts.keepData === true || process.env['SUDO_EVAL_KEEP_DATA'] === '1')) {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  return { runId, scenarioId: scenario.id, passed: scores.success, scores, journalPath, workspaceDir, turn };
}

function scoresForJournal(s: ScoreVector): Record<string, unknown> {
  return {
    success: s.success,
    checksPassed: s.checksPassed,
    checksTotal: s.checksTotal,
    efficiency: s.efficiency,
    policyViolations: s.policyViolations,
    checks: s.checkOutcomes.map((o) => ({ type: o.check.type, passed: o.passed, detail: o.detail })),
  };
}

function persistToBench(
  scenario: Scenario,
  runId: string,
  scores: ScoreVector,
  turn: EvalTurnResult,
  benchDbPath?: string,
): void {
  try {
    const store = new BenchStore(benchDbPath ?? dataPath('bench.db'));
    try {
      const row: BenchResult = {
        id: `eval-sandbox-${runId}`,
        runId,
        model: 'unknown',
        agentId: 'eval-sandbox',
        taskId: scenario.id,
        condition: 'no_skills',
        seedIndex: 0,
        success: scores.success,
        latencyMs: scores.efficiency.wallMs,
        costUsd: turn.usd ?? 0,
        complexityTier: 'simple',
        timestamp: new Date().toISOString(),
        score: scores.checksTotal > 0 ? scores.checksPassed / scores.checksTotal : 0,
        verifierType: 'eval-sandbox',
        verifierDetail: JSON.stringify({
          checksPassed: scores.checksPassed,
          checksTotal: scores.checksTotal,
          policyViolations: scores.policyViolations,
        }),
        wallTimeMs: scores.efficiency.wallMs,
      };
      store.insertResult(row);
    } finally {
      store.close();
    }
  } catch (err) {
    // Scoring persistence is telemetry; the run report is authoritative.
    log.warn({ err: String(err), runId }, 'eval-sandbox: bench persistence failed');
  }
}
