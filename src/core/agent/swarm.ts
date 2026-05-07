/**
 * @file swarm.ts
 * @description AgentSwarm — spawns isolated sub-agents with concurrency limiting.
 *
 * Each sub-agent runs in its own ephemeral session. A maximum of 4 sub-agents
 * run concurrently (enforced via p-queue). Each sub-agent has a configurable
 * wall-clock timeout (default 5 minutes).
 */

import PQueue from 'p-queue';
import { createLogger } from '../shared/index.js';
import { genId } from '../shared/index.js';
import { PipelineError } from '../shared/index.js';
import { MAX_SWARM_AGENTS } from '../shared/constants.js';
import { AgentLoop } from './loop.js';
import { createIsolatedAgent } from './isolation.js';
import type { IsolationMode } from './isolation.js';
import type { AgentConfig } from './types.js';
import type { HookManager } from '../hooks/index.js';

const log = createLogger('agent:swarm');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * Milliseconds of silence after which a sub-agent is considered idle.
 * Used by getIdleAgents() — callers can pass this to TeammateIdleDetector.
 */
const IDLE_THRESHOLD_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for spawning a sub-agent. */
export interface SpawnOptions {
  /** Override the LLM model for this sub-agent. */
  model?: string;
  /** Override the persona (passed via AgentConfig). */
  persona?: string;
  /** Restrict tools available to this sub-agent (not enforced yet — reserved). */
  tools?: string[];
  /** Wall-clock timeout in ms before the sub-agent is killed. Default: 5 min. */
  timeout?: number;
  /**
   * Workspace isolation mode for the sub-agent.
   * - undefined / 'shared' — runs in the main process cwd (default, no overhead)
   * - 'sandboxed'          — gets an isolated /tmp directory
   * - 'worktree'           — gets a dedicated git worktree branch
   */
  isolationMode?: IsolationMode;
}

/** Runtime record of an active sub-agent. */
export interface ActiveAgent {
  /** Unique sub-agent ID. */
  id: string;
  /** The task description passed at spawn time. */
  task: string;
  /** When spawn() was called. */
  startedAt: Date;
  /** AbortController to cancel the sub-agent. */
  controller: AbortController;
  /**
   * Unix epoch ms of the last observable activity (tool call, message, etc.).
   * Updated by refreshHeartbeat().
   */
  lastHeartbeat: number;
}

// ---------------------------------------------------------------------------
// AgentSwarm
// ---------------------------------------------------------------------------

/**
 * Manages a pool of concurrently running sub-agents, each with their own
 * ephemeral session. Uses p-queue to cap concurrency at MAX_CONCURRENT.
 *
 * Dependencies are duck-typed to avoid circular imports. Inject the same
 * brain, toolRegistry, and sessionManager instances used by the main loop.
 */
export class AgentSwarm {
  private readonly brain: unknown;
  private readonly toolRegistry: unknown;
  private readonly sessionManager: unknown;
  private readonly queue: PQueue;
  private readonly active = new Map<string, ActiveAgent>();
  private readonly hookManager: HookManager | null;

  /**
   * @param brain          - Brain instance (duck-typed: must have call()).
   * @param toolRegistry   - ToolRegistry instance (duck-typed).
   * @param sessionManager - SessionManager instance (duck-typed: must have get/save).
   * @param hookManager    - Optional HookManager for lifecycle event emission.
   */
  constructor(
    brain: unknown,
    toolRegistry: unknown,
    sessionManager: unknown,
    hookManager?: HookManager | null,
  ) {
    if (!brain || typeof (brain as { call?: unknown }).call !== 'function') {
      throw new PipelineError('AgentSwarm: brain must have a call() method', 'pipeline_invalid_brain');
    }
    if (!toolRegistry || typeof (toolRegistry as { execute?: unknown }).execute !== 'function') {
      throw new PipelineError('AgentSwarm: toolRegistry must have execute()', 'pipeline_invalid_registry');
    }
    if (!sessionManager || typeof (sessionManager as { get?: unknown }).get !== 'function') {
      throw new PipelineError('AgentSwarm: sessionManager must have get() and save()', 'pipeline_invalid_session_manager');
    }

    this.brain = brain;
    this.toolRegistry = toolRegistry;
    this.sessionManager = sessionManager;
    this.hookManager = hookManager ?? null;
    this.queue = new PQueue({ concurrency: MAX_SWARM_AGENTS });

    log.info({ maxConcurrent: MAX_SWARM_AGENTS }, 'AgentSwarm initialized');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Spawn a single sub-agent to handle a task.
   *
   * Creates an ephemeral session, runs AgentLoop, and returns the result.
   * The sub-agent is killed if it exceeds its timeout.
   *
   * @param taskDescription - Natural-language task for the sub-agent.
   * @param options         - Optional overrides for model, timeout, etc.
   * @returns The sub-agent's final response string.
   * @throws PipelineError on timeout or unrecoverable error.
   */
  async spawn(taskDescription: string, options: SpawnOptions = {}): Promise<string> {
    if (!taskDescription || typeof taskDescription !== 'string') {
      throw new PipelineError(
        'AgentSwarm.spawn: taskDescription must be a non-empty string',
        'pipeline_invalid_args',
      );
    }

    const id = genId();
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();

    return this.queue.add(async () => {
      const record: ActiveAgent = {
        id,
        task: taskDescription,
        startedAt: new Date(),
        controller,
        lastHeartbeat: Date.now(),
      };
      this.active.set(id, record);

      // Emit swarm:spawn lifecycle event.
      if (this.hookManager) {
        await this.hookManager.emit('swarm:spawn', {
          event: 'swarm:spawn',
          meta: { agentId: id, task: taskDescription.slice(0, 100) },
        });
      }

      log.info({ id, task: taskDescription.slice(0, 100), timeout }, 'Sub-agent spawning');

      // Create an ephemeral session.
      const sessionManager = this.sessionManager as {
        getOrCreate: (channel: string, peerId: string) => Promise<{ id: string }>;
      };

      let sessionId: string;
      try {
        const session = await sessionManager.getOrCreate('swarm', `subagent:${id}`);
        sessionId = session.id;
      } catch (err) {
        this.active.delete(id);
        throw new PipelineError(
          `AgentSwarm: failed to create session for sub-agent ${id}: ${String(err)}`,
          'pipeline_session_not_found',
          { id },
        );
      }

      const config: Partial<AgentConfig> = {
        timeout,
        ...(options.model ? { model: options.model } : {}),
      };

      // Optional workspace isolation.
      const isolationMode = options.isolationMode ?? 'shared';
      let isolatedEnv: Awaited<ReturnType<typeof createIsolatedAgent>> | null = null;
      if (isolationMode !== 'shared') {
        try {
          isolatedEnv = await createIsolatedAgent(isolationMode);
          log.info({ id, isolationMode, workdir: isolatedEnv.workdir }, 'Sub-agent isolation environment created');
        } catch (isoErr) {
          log.warn({ id, isolationMode, err: String(isoErr) }, 'Failed to create isolated environment — falling back to shared');
          isolatedEnv = null;
        }
      }

      const sandboxManager = {
        getWorkspaceDir: (sid: string) => `/tmp/sandbox-${sid}`,
        getPolicyFor: () => ({ readonly: false, allowedPaths: ['/tmp'] }),
      };
      const loop = new AgentLoop(this.brain, this.toolRegistry, this.sessionManager, config, undefined, undefined, undefined, undefined, sandboxManager);

      // Apply timeout via AbortController.
      const timer = setTimeout(() => {
        controller.abort();
        log.error({ id, timeout }, 'Sub-agent timed out — aborting');
      }, timeout);

      try {
        const agentResult = await loop.run(sessionId, taskDescription);
        const resultText = agentResult.text;
        log.info({ id, resultLen: resultText.length }, 'Sub-agent completed');

        // Emit swarm:complete lifecycle event.
        if (this.hookManager) {
          await this.hookManager.emit('swarm:complete', {
            event: 'swarm:complete',
            meta: { agentId: id, resultLen: resultText.length },
          });
        }

        return resultText;
      } catch (err) {
        if (controller.signal.aborted) {
          throw new PipelineError(
            `Sub-agent ${id} timed out after ${timeout}ms`,
            'pipeline_max_iterations',
            { id, timeout },
          );
        }
        log.error({ id, err }, 'Sub-agent failed');
        throw err;
      } finally {
        clearTimeout(timer);
        this.active.delete(id);
        // Always clean up isolated environment, even on error.
        if (isolatedEnv) {
          try {
            await isolatedEnv.cleanup();
          } catch (cleanErr) {
            log.warn({ id, isolationMode, err: String(cleanErr) }, 'Isolation cleanup failed');
          }
        }
      }
    }) as Promise<string>;
  }

  /**
   * Spawn multiple sub-agents in parallel, up to MAX_CONCURRENT at a time.
   *
   * @param tasks   - Array of task description strings.
   * @param options - Shared options applied to all sub-agents.
   * @returns Array of result strings in the same order as tasks.
   */
  async spawnMany(tasks: string[], options: SpawnOptions = {}): Promise<string[]> {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new PipelineError('AgentSwarm.spawnMany: tasks must be a non-empty array', 'pipeline_invalid_args');
    }

    log.info({ count: tasks.length }, 'spawnMany called');
    return Promise.all(tasks.map((task) => this.spawn(task, options)));
  }

  /**
   * Return a snapshot of currently active sub-agents.
   * Does not include the controller (not serialisable).
   */
  getActive(): Array<{ id: string; task: string; startedAt: Date }> {
    return [...this.active.values()].map(({ id, task, startedAt }) => ({
      id,
      task,
      startedAt,
    }));
  }

  /**
   * Return all active agents alongside their last-heartbeat timestamp.
   * Intended for use with TeammateIdleDetector.
   *
   * An agent is considered to have been idle when its lastHeartbeat has not
   * been refreshed within IDLE_THRESHOLD_MS.  Callers can use this list
   * directly or pass it to a TeammateIdleDetector:
   *
   * ```ts
   * const detector = new TeammateIdleDetector(
   *   () => swarm.getIdleAgents(),
   *   (id) => log.warn({ id }, 'Agent idle'),
   * );
   * ```
   */
  getIdleAgents(): Array<{ id: string; lastActiveAt: number }> {
    const now = Date.now();
    return [...this.active.values()]
      .filter((agent) => now - agent.lastHeartbeat > IDLE_THRESHOLD_MS)
      .map(({ id, lastHeartbeat }) => ({ id, lastActiveAt: lastHeartbeat }));
  }

  /**
   * Refresh the heartbeat for a running sub-agent.
   * Call this from within the agent loop whenever meaningful activity occurs
   * (e.g. after each tool call) so the idle detector does not false-fire.
   *
   * @param id - Sub-agent ID to refresh.
   */
  refreshHeartbeat(id: string): void {
    const agent = this.active.get(id);
    if (agent) {
      agent.lastHeartbeat = Date.now();
    }
  }

  /**
   * Cancel a running sub-agent by ID.
   * This aborts its AbortController; the sub-agent will error out on next await.
   *
   * @param id - Sub-agent ID returned from getActive().
   */
  kill(id: string): void {
    const agent = this.active.get(id);
    if (!agent) {
      log.warn({ id }, 'kill: sub-agent not found');
      return;
    }
    agent.controller.abort();
    this.active.delete(id);
    log.info({ id }, 'Sub-agent killed');
  }

  /** Cancel all running sub-agents. */
  killAll(): void {
    const ids = [...this.active.keys()];
    if (ids.length === 0) return;
    log.info({ count: ids.length }, 'killAll: aborting all sub-agents');
    for (const id of ids) {
      this.kill(id);
    }
  }

  /** Number of tasks currently queued or running. */
  get size(): number {
    return this.queue.size + this.queue.pending;
  }
}
