/**
 * @file agent-bench-runner.ts
 * @description AgentBenchRunner — invokes the real SUDO AI agent loop against a
 * workspace task and scores the agent's final workspace state.
 *
 * This is the "scale that actually weighs the agent" companion to BenchRunner.
 * Where BenchRunner calls brain.call({messages}) once and scores the response
 * text, AgentBenchRunner spins up a real AgentLoop with tools, lets it iterate,
 * then runs the task's held-out verifier against the resulting workspace.
 *
 * Bootstrap mirrors {@link TuiAgentAdapter} (cli/commands/chat/agent-loop-adapter.ts:50):
 * private DATA_DIR to avoid SQLite-lock contention with the pm2 daemon, full
 * ConfigLoader → Brain → ToolRegistry → MindDB → SessionManager → AgentLoop.
 *
 * For tests, inject `agentLoop` + `sessionManager` deps via the constructor and
 * skip the bootstrap entirely.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { AgentBenchResult, AgentBenchTask } from './agent-bench-types.js';

const log = createLogger('eval:agent-bench-runner');

// ---------------------------------------------------------------------------
// Duck-typed deps (the only surface the runner depends on)
// ---------------------------------------------------------------------------

export interface AgentLoopLike {
  run(
    sessionId: string,
    message: string,
    onEvent?: (event: { type: string; [k: string]: unknown }) => void,
  ): Promise<{ text: string; attachments: unknown[] }>;
}

export interface SessionManagerLike {
  getOrCreate(channel: string, peerId: string): Promise<{ id: string | number }>;
}

/**
 * Reads cumulative estimated cost (USD) from the bench's cost tracker. The runner
 * snapshots it before and after each task; the delta is that task's cost. Kept as
 * a one-method interface so tests can inject a fake and the bootstrap can back it
 * with the real (isolated) CostTracker.
 */
export interface CostMeter {
  totalCostUsd(): number;
}

export interface AgentBenchDeps {
  agentLoop: AgentLoopLike;
  sessionManager: SessionManagerLike;
  /** Optional model label recorded in the result. Default 'unknown'. */
  modelLabel?: string;
  /** Optional cost meter. When absent, recorded cost is 0. */
  costMeter?: CostMeter;
}

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

export interface AgentBenchRunOptions {
  /** When true, leave the workspace dir on disk after the run (for debugging). */
  keepWorkspace?: boolean;
}

// ---------------------------------------------------------------------------
// AgentBenchRunner
// ---------------------------------------------------------------------------

export class AgentBenchRunner {
  private readonly providedDeps?: AgentBenchDeps;
  private readonly bootstrapOpts?: BootstrapOptions;
  private resolvedDeps: AgentBenchDeps | null = null;

  /**
   * Construct with injected deps (for tests) OR with bootstrap options that
   * configure the auto-built AgentLoop (real run path).
   */
  constructor(
    depsOrOpts?: AgentBenchDeps | { bootstrap: BootstrapOptions },
  ) {
    if (depsOrOpts && 'agentLoop' in depsOrOpts) {
      this.providedDeps = depsOrOpts;
    } else if (depsOrOpts && 'bootstrap' in depsOrOpts) {
      this.bootstrapOpts = depsOrOpts.bootstrap;
    }
  }

  /**
   * Run one task end-to-end: setup workspace → bootstrap → agent loop → verify.
   */
  async run(task: AgentBenchTask, opts: AgentBenchRunOptions = {}): Promise<AgentBenchResult> {
    const startedAt = new Date().toISOString();
    const wallStart = Date.now();

    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-bench-${task.id}-`));
    log.info({ taskId: task.id, workspaceDir }, 'AgentBenchRunner: workspace created');

    try {
      await task.setupWorkspace(workspaceDir);

      const deps = await this._resolveDeps();
      const peerId = `agent-bench-${task.id}-${Date.now()}`;
      const session = await deps.sessionManager.getOrCreate('web', peerId);
      const sessionId = String(session.id);

      const prompt = task.prompt.replace(/\{workspace\}/g, workspaceDir);

      let toolCallCount = 0;
      const onEvent = (event: { type: string }): void => {
        if (event.type === 'tool-call') toolCallCount++;
      };

      log.info({ taskId: task.id, sessionId, model: deps.modelLabel }, 'AgentBenchRunner: invoking agent loop');
      const costBefore = deps.costMeter?.totalCostUsd() ?? 0;
      const agentResult = await deps.agentLoop.run(sessionId, prompt, onEvent);
      const agentText = typeof agentResult.text === 'string' ? agentResult.text : '';
      // Delta over the run. Guarded against a day-boundary reset in getTodayCost().
      const costUsd = Math.max(0, (deps.costMeter?.totalCostUsd() ?? 0) - costBefore);

      const verdict = await task.verifyWorkspace(workspaceDir);
      const wallTimeMs = Date.now() - wallStart;
      const transcriptHash = agentText.length > 0
        ? createHash('sha256').update(agentText).digest('hex')
        : '';

      const result: AgentBenchResult = {
        taskId: task.id,
        model: deps.modelLabel ?? 'unknown',
        passed: verdict.passed,
        score: verdict.score,
        detail: verdict.detail,
        agentText,
        wallTimeMs,
        costUsd,
        toolCallCount,
        transcriptHash,
        startedAt,
      };

      log.info(
        { taskId: task.id, passed: result.passed, score: result.score, wallTimeMs, costUsd, toolCallCount },
        'AgentBenchRunner: run complete',
      );
      return result;
    } finally {
      if (!opts.keepWorkspace) {
        try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      } else {
        log.info({ workspaceDir }, 'AgentBenchRunner: workspace kept for inspection');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Bootstrap (lazy, only when no deps were injected)
  // ---------------------------------------------------------------------------

  private async _resolveDeps(): Promise<AgentBenchDeps> {
    if (this.resolvedDeps) return this.resolvedDeps;
    if (this.providedDeps) {
      this.resolvedDeps = this.providedDeps;
      return this.resolvedDeps;
    }
    this.resolvedDeps = await bootstrapRealAgentLoop(this.bootstrapOpts ?? {});
    return this.resolvedDeps;
  }
}

// ---------------------------------------------------------------------------
// Real bootstrap (mirrors TuiAgentAdapter._bootstrap)
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  /**
   * Override AgentConfig.model. Useful when the config's default model needs
   * credentials this process doesn't have (e.g. PM2 daemon has them, this bench
   * harness inherits no env keys). When set, recorded as the result's `model`.
   * Default: config's `intelligence.default_model`.
   */
  modelOverride?: string;
  /** Override AgentConfig.maxIterations. Default 30. */
  maxIterations?: number;
}

/**
 * Self-contained AgentLoop bootstrap for the bench harness. Uses a private
 * DATA_DIR so the bench's MindDB / audit / trust DBs don't collide with the
 * pm2-running daemon's write locks. Exported so callers can introspect or
 * override individual pieces.
 */
export async function bootstrapRealAgentLoop(opts: BootstrapOptions = {}): Promise<AgentBenchDeps> {
  const benchDataDir = path.join(
    process.env['HOME'] ?? '/root',
    '.sudo-ai',
    'bench-data',
  );
  fs.mkdirSync(benchDataDir, { recursive: true });
  process.env['DATA_DIR'] = benchDataDir;

  const { ConfigLoader } = await import('../config/loader.js');
  const configLoader = new ConfigLoader();
  await configLoader.load();
  const config = configLoader.get();

  // Seed the cost-tracker singleton to the bench's ISOLATED mind.db BEFORE the
  // Brain is constructed, so per-task cost deltas measure only this process's
  // calls — not the pm2 daemon's concurrent traffic against the shared DB.
  const benchMindDb = path.join(benchDataDir, 'mind.db');
  const { getCostTracker } = await import('../billing/cost-tracker.js');
  const costTracker = getCostTracker(benchMindDb);

  const { Brain } = await import('../brain/brain.js');
  const brain = new Brain(config);

  const { ToolRegistry } = await import('../tools/registry.js');
  const { loadBuiltinTools } = await import('../tools/loader.js');
  const registry = new ToolRegistry();
  ToolRegistry.setGlobal(registry);
  const toolsDir = new URL('../tools/builtin', import.meta.url).pathname;
  await loadBuiltinTools(registry, toolsDir);

  const { MindDB } = await import('../memory/db.js');
  const { SessionManager } = await import('../sessions/manager.js');
  const db = new MindDB(benchMindDb);
  const sessionMgr = new SessionManager(db);

  const { AgentLoop } = await import('../agent/loop.js');
  const sandboxManager = {
    getWorkspaceDir: () => path.join(benchDataDir, 'workspace'),
    getPolicyFor: () => ({
      readonly: false,
      allowedPaths: [benchDataDir, os.tmpdir(), process.cwd()],
    }),
  };
  const agentConfig: { maxIterations: number; model?: string } = {
    maxIterations: opts.maxIterations ?? 30,
  };
  if (opts.modelOverride) agentConfig.model = opts.modelOverride;
  const agentLoop = new AgentLoop(
    brain,
    registry,
    sessionMgr,
    agentConfig,
    undefined, undefined, undefined, undefined,
    sandboxManager,
  );

  const modelLabel = opts.modelOverride
    ?? (config as { intelligence?: { default_model?: string } })?.intelligence?.default_model
    ?? 'unknown';

  return {
    agentLoop: agentLoop as unknown as AgentLoopLike,
    sessionManager: sessionMgr as unknown as SessionManagerLike,
    modelLabel,
    costMeter: { totalCostUsd: () => costTracker.getTodayCost().total },
  };
}
