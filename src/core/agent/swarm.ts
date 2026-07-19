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
import { pushCompletionBus } from './push-completion.js';
import { seedForkedHistory } from './fork-history.js';
import { loadResumeMessages, seedResumeHistory } from './subagent-resume.js';
import type { ForkableMessage } from './fork-history.js';
import { SpawnSlotGuard } from './spawn-guard.js';

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
  /**
   * Parent conversation history to fork into the sub-agent's session.
   * Filtered before seeding (fork-mode): system/user messages and
   * final-answer assistant messages are kept; tool results and
   * intermediate assistant turns are dropped. Omitted (default) — the
   * sub-agent starts with an empty session, exactly as before.
   */
  forkHistory?: ForkableMessage[];
  /**
   * Resume from a previously-completed sub-agent (gap #21). When set,
   * the swarm loads the named agent's session transcript verbatim
   * (system + user + assistant + tool messages — full arc) and splices
   * it onto the new sub-agent's session BEFORE the loop runs, so the
   * new prompt lands on top of a finished conversation. Distinct from
   * `forkHistory` which is the FILTERED parent-conversation seeding
   * path; resume keeps the full transcript including tool I/O.
   *
   * If both `resumeFromAgentId` and `forkHistory` are set, the resumed
   * messages go in FIRST (oldest position), then the parent fork
   * messages, then the new task. Unknown agent ids fail open — the new
   * sub-agent starts cold with a warn log.
   */
  resumeFromAgentId?: string;
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

/**
 * Public read-only snapshot of one active sub-agent. Used by the FleetView
 * dashboard endpoint (gap #25 slice 1). Cannot leak the AbortController.
 */
export interface AgentSnapshot {
  /** Stable sub-agent id. */
  id: string;
  /** Task description, truncated to a UI-safe length. */
  task: string;
  /** ISO-8601 timestamp of spawn. */
  startedAt: string;
  /** Wall-clock elapsed since spawn, computed at snapshot time. */
  elapsedMs: number;
  /** Wall-clock since last `refreshHeartbeat()`, computed at snapshot time. */
  sinceHeartbeatMs: number;
  /** True when `sinceHeartbeatMs >= IDLE_THRESHOLD_MS`. */
  idle: boolean;
}

/** Aggregate view of the swarm — what the dashboard renders. */
export interface SwarmSnapshot {
  /** Live sub-agents, ordered oldest-spawned first. */
  spawned: AgentSnapshot[];
  /** Currently running concurrent agents (p-queue active count). */
  slotsUsed: number;
  /** Max concurrent agents (MAX_SWARM_AGENTS). */
  slotsMax: number;
  /** Tasks waiting in the p-queue (admitted but not running). */
  queueWaiting: number;
}

/** Maximum task chars in a snapshot — keeps the dashboard JSON tight. */
const SNAPSHOT_TASK_MAX_CHARS = 140;

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

      // RAII slot guard: everything below runs inside a single try/finally so
      // an early throw (hook emit, session creation, AgentLoop construction)
      // can never leak the active record, an isolation environment, or leave
      // pushCompletionBus subscribers waiting forever.
      const guard = new SpawnSlotGuard(() => {
        pushCompletionBus.fail(id, {
          agentId: id,
          task: taskDescription,
          error: 'Sub-agent spawn aborted before reporting a result',
        });
      });
      guard.defer(() => {
        this.active.delete(id);
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
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
          getOrCreate: (channel: string, peerId: string) => Promise<{ id: string; messages?: unknown }>;
          save?: (session: unknown) => Promise<void>;
        };

        let sessionId: string;
        let session: { id: string; messages?: unknown };
        try {
          session = await sessionManager.getOrCreate('swarm', `subagent:${id}`);
          sessionId = session.id;
        } catch (err) {
          throw new PipelineError(
            `AgentSwarm: failed to create session for sub-agent ${id}: ${String(err)}`,
            'pipeline_session_not_found',
            { id },
          );
        }

        // gap #21 — resume_from a finished sub-agent. Loads the prior
        // transcript (user + assistant + tool — system messages excluded;
        // see subagent-resume.ts JSDoc for the brain.ts:131 reason) and
        // splices it ahead of any fork-mode seeding so the new prompt
        // lands on top of the resumed conversation. Fail-open: unknown
        // agent id or any load error → warn log and start cold.
        //
        // Resume + fork both mutate session.messages in place; a single
        // save at the END of seeding avoids the partial-write window the
        // verifier flagged (HIGH #2) — if the resume save succeeded but
        // the fork save crashed, the on-disk session was inconsistent.
        let anySeeded = false;
        if (options.resumeFromAgentId) {
          try {
            const resumed = await loadResumeMessages(sessionManager, options.resumeFromAgentId);
            if (resumed.length > 0) {
              const kept = seedResumeHistory(session, resumed);
              if (kept > 0) anySeeded = true;
              log.info(
                { id, resumeFromAgentId: options.resumeFromAgentId, kept },
                'Resume seeded prior sub-agent transcript into new session',
              );
            } else {
              log.warn(
                { id, resumeFromAgentId: options.resumeFromAgentId },
                'Resume requested but prior sub-agent has no messages — starting cold',
              );
            }
          } catch (resumeErr) {
            log.warn(
              { id, resumeFromAgentId: options.resumeFromAgentId, err: String(resumeErr) },
              'Resume seeding failed — sub-agent starts without prior transcript',
            );
          }
        }

        // Fork-mode context: seed the filtered parent history (fail-open).
        if (options.forkHistory && options.forkHistory.length > 0) {
          try {
            const kept = seedForkedHistory(session, options.forkHistory);
            if (kept > 0) anySeeded = true;
            log.info(
              { id, kept, dropped: options.forkHistory.length - kept },
              'Fork-mode history seeded into sub-agent session',
            );
          } catch (forkErr) {
            log.warn({ id, err: String(forkErr) }, 'Fork history seeding failed — sub-agent starts without parent context');
          }
        }

        // Single atomic save covering both seedings — verifier HIGH #2.
        if (anySeeded && typeof sessionManager.save === 'function') {
          try {
            await sessionManager.save(session);
          } catch (saveErr) {
            log.warn({ id, err: String(saveErr) }, 'Seed save failed — sub-agent will run with in-memory session only');
          }
        }

        const config: Partial<AgentConfig> = {
          timeout,
          ...(options.model ? { model: options.model } : {}),
        };

        // Optional workspace isolation.
        const isolationMode = options.isolationMode ?? 'shared';
        if (isolationMode !== 'shared') {
          try {
            const isolatedEnv = await createIsolatedAgent(isolationMode);
            guard.defer(() => isolatedEnv.cleanup());
            log.info({ id, isolationMode, workdir: isolatedEnv.workdir }, 'Sub-agent isolation environment created');
          } catch (isoErr) {
            log.warn({ id, isolationMode, err: String(isoErr) }, 'Failed to create isolated environment — falling back to shared');
          }
        }

        const sandboxManager = {
          getWorkspaceDir: (sid: string) => `/tmp/sandbox-${sid}`,
          getPolicyFor: () => ({ readonly: false, allowedPaths: ['/tmp'] }),
        };
        const loop = new AgentLoop(this.brain, this.toolRegistry, this.sessionManager, config, undefined, undefined, undefined, undefined, sandboxManager);

        // Apply timeout via AbortController + a racing timeout promise.
        // The AbortController alone does not stop loop.run() (the loop does not
        // accept the signal), so we also race the run against a rejecting timer.
        // This frees the queue slot and removes the active record on timeout
        // instead of waiting for the loop's natural completion.
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            log.error({ id, timeout }, 'Sub-agent timed out — aborting');
            reject(
              new PipelineError(
                `Sub-agent ${id} timed out after ${timeout}ms`,
                'pipeline_max_iterations',
                { id, timeout },
              ),
            );
          }, timeout);
        });

        const startTime = Date.now();
        const runPromise = loop.run(sessionId, taskDescription, undefined, { promptProfile: 'subagent' });
        // Swallow any late rejection if the timeout wins the race below, so the
        // still-running loop does not surface as an unhandled rejection.
        runPromise.catch(() => { /* handled via race / timeout below */ });
        const agentResult = await Promise.race([runPromise, timeoutPromise]);
        const resultText = agentResult.text;
        const duration = Date.now() - startTime;
        log.info({ id, resultLen: resultText.length, duration }, 'Sub-agent completed');

        // Emit swarm:complete lifecycle event.
        if (this.hookManager) {
          await this.hookManager.emit('swarm:complete', {
            event: 'swarm:complete',
            meta: { agentId: id, resultLen: resultText.length },
          });
        }

        // Push-based completion notification for async subscribers.
        pushCompletionBus.complete(id, {
          agentId: id,
          task: taskDescription,
          result: resultText,
          duration,
        });
        guard.commit();

        return resultText;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (controller.signal.aborted) {
          const timeoutError = new PipelineError(
            `Sub-agent ${id} timed out after ${timeout}ms`,
            'pipeline_max_iterations',
            { id, timeout },
          );
          // Push-based failure notification for async subscribers.
          pushCompletionBus.fail(id, {
            agentId: id,
            task: taskDescription,
            error: timeoutError.message,
          });
          guard.commit();
          throw timeoutError;
        }

        // Push-based failure notification for async subscribers.
        pushCompletionBus.fail(id, {
          agentId: id,
          task: taskDescription,
          error: errorMessage,
        });
        guard.commit();

        log.error({ id, err }, 'Sub-agent failed');
        throw err;
      } finally {
        clearTimeout(timer);
        // Removes the active record and cleans up any isolation environment;
        // notifies subscribers if the spawn aborted before reporting.
        await guard.release();
      }
    }) as Promise<string>;
  }

  /**
   * Spawn a sub-agent asynchronously and return immediately with the agent ID.
   * The caller can subscribe to pushCompletionBus to receive completion events.
   *
   * @param taskDescription - Natural-language task for the sub-agent.
   * @param options - Optional overrides for model, timeout, etc.
   * @returns The sub-agent ID immediately (does not wait for completion).
   */
  async spawnAsync(taskDescription: string, options: SpawnOptions = {}): Promise<string> {
    if (!taskDescription || typeof taskDescription !== 'string') {
      throw new PipelineError(
        'AgentSwarm.spawnAsync: taskDescription must be a non-empty string',
        'pipeline_invalid_args',
      );
    }

    const id = genId();
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();

    // Start the sub-agent in the background (do not await).
    // The caller subscribes to pushCompletionBus for results.
    this.queue
      .add(async () => {
        const record: ActiveAgent = {
          id,
          task: taskDescription,
          startedAt: new Date(),
          controller,
          lastHeartbeat: Date.now(),
        };
        this.active.set(id, record);

        // RAII slot guard — see spawn() for semantics.
        const guard = new SpawnSlotGuard(() => {
          pushCompletionBus.fail(id, {
            agentId: id,
            task: taskDescription,
            error: 'Sub-agent spawn aborted before reporting a result',
          });
        });
        guard.defer(() => {
          this.active.delete(id);
        });

        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Emit swarm:spawn lifecycle event.
          if (this.hookManager) {
            await this.hookManager.emit('swarm:spawn', {
              event: 'swarm:spawn',
              meta: { agentId: id, task: taskDescription.slice(0, 100) },
            });
          }

          log.info({ id, task: taskDescription.slice(0, 100), timeout }, 'Async sub-agent spawning');

          // Create an ephemeral session.
          const sessionManager = this.sessionManager as {
            getOrCreate: (channel: string, peerId: string) => Promise<{ id: string; messages?: unknown }>;
            save?: (session: unknown) => Promise<void>;
          };

          const session = await sessionManager.getOrCreate('swarm', `subagent:${id}`);
          const sessionId = session.id;

          // gap #21 — resume_from a finished sub-agent (async variant).
          // Same semantics as spawn(): full transcript, splice before
          // fork seeding, single atomic save at the end (verifier HIGH
          // #2), fail-open on unknown agent id.
          let anySeeded = false;
          if (options.resumeFromAgentId) {
            try {
              const resumed = await loadResumeMessages(sessionManager, options.resumeFromAgentId);
              if (resumed.length > 0) {
                const kept = seedResumeHistory(session, resumed);
                if (kept > 0) anySeeded = true;
                log.info(
                  { id, resumeFromAgentId: options.resumeFromAgentId, kept },
                  'Resume seeded prior sub-agent transcript into async sub-agent session',
                );
              } else {
                log.warn(
                  { id, resumeFromAgentId: options.resumeFromAgentId },
                  'Resume requested but prior sub-agent has no messages — starting cold',
                );
              }
            } catch (resumeErr) {
              log.warn(
                { id, resumeFromAgentId: options.resumeFromAgentId, err: String(resumeErr) },
                'Resume seeding failed — async sub-agent starts without prior transcript',
              );
            }
          }

          // Fork-mode context: seed the filtered parent history (fail-open).
          if (options.forkHistory && options.forkHistory.length > 0) {
            try {
              const kept = seedForkedHistory(session, options.forkHistory);
              if (kept > 0) anySeeded = true;
              log.info(
                { id, kept, dropped: options.forkHistory.length - kept },
                'Fork-mode history seeded into async sub-agent session',
              );
            } catch (forkErr) {
              log.warn({ id, err: String(forkErr) }, 'Fork history seeding failed — sub-agent starts without parent context');
            }
          }

          // Single atomic save covering both seedings — verifier HIGH #2.
          if (anySeeded && typeof sessionManager.save === 'function') {
            try {
              await sessionManager.save(session);
            } catch (saveErr) {
              log.warn({ id, err: String(saveErr) }, 'Seed save failed — async sub-agent will run with in-memory session only');
            }
          }

          const config: Partial<AgentConfig> = {
            timeout,
            ...(options.model ? { model: options.model } : {}),
          };

          // Optional workspace isolation.
          const isolationMode = options.isolationMode ?? 'shared';
          if (isolationMode !== 'shared') {
            try {
              const isolatedEnv = await createIsolatedAgent(isolationMode);
              guard.defer(() => isolatedEnv.cleanup());
              log.info({ id, isolationMode, workdir: isolatedEnv.workdir }, 'Async sub-agent isolation environment created');
            } catch (isoErr) {
              log.warn({ id, isolationMode, err: String(isoErr) }, 'Failed to create isolated environment — falling back to shared');
            }
          }

          const sandboxManager = {
            getWorkspaceDir: (sid: string) => `/tmp/sandbox-${sid}`,
            getPolicyFor: () => ({ readonly: false, allowedPaths: ['/tmp'] }),
          };
          const loop = new AgentLoop(this.brain, this.toolRegistry, this.sessionManager, config, undefined, undefined, undefined, undefined, sandboxManager);

          // Apply timeout via AbortController + a racing timeout promise.
          // The AbortController alone does not stop loop.run() (the loop does not
          // accept the signal), so we also race the run against a rejecting timer.
          // This frees the queue slot and removes the active record on timeout
          // instead of waiting for the loop's natural completion.
          const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              log.error({ id, timeout }, 'Async sub-agent timed out — aborting');
              reject(
                new PipelineError(
                  `Sub-agent ${id} timed out after ${timeout}ms`,
                  'pipeline_max_iterations',
                  { id, timeout },
                ),
              );
            }, timeout);
          });

          const startTime = Date.now();
          const runPromise = loop.run(sessionId, taskDescription, undefined, { promptProfile: 'subagent' });
          // Swallow any late rejection if the timeout wins the race below, so the
          // still-running loop does not surface as an unhandled rejection.
          runPromise.catch(() => { /* handled via race / timeout below */ });
          const agentResult = await Promise.race([runPromise, timeoutPromise]);
          const resultText = agentResult.text;
          const duration = Date.now() - startTime;
          log.info({ id, resultLen: resultText.length, duration }, 'Async sub-agent completed');

          // Emit swarm:complete lifecycle event.
          if (this.hookManager) {
            await this.hookManager.emit('swarm:complete', {
              event: 'swarm:complete',
              meta: { agentId: id, resultLen: resultText.length },
            });
          }

          // Push-based completion notification.
          pushCompletionBus.complete(id, {
            agentId: id,
            task: taskDescription,
            result: resultText,
            duration,
          });
          guard.commit();
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);

          if (controller.signal.aborted) {
            pushCompletionBus.fail(id, {
              agentId: id,
              task: taskDescription,
              error: `Timed out after ${timeout}ms`,
            });
          } else {
            pushCompletionBus.fail(id, {
              agentId: id,
              task: taskDescription,
              error: errorMessage,
            });
          }
          guard.commit();
          log.error({ id, err }, 'Async sub-agent failed');
        } finally {
          clearTimeout(timer);
          // Removes the active record and cleans up any isolation environment;
          // notifies subscribers if the spawn aborted before reporting.
          await guard.release();
        }
      })
      .catch((queueErr) => {
        // Queue-level error (e.g., concurrency limit issues).
        log.error({ id, err: queueErr }, 'Async sub-agent queue error');
        pushCompletionBus.fail(id, {
          agentId: id,
          task: taskDescription,
          error: String(queueErr),
        });
      });

    // Return immediately without waiting for completion.
    return id;
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
   * Return a richer read-only snapshot of the swarm — what the FleetView
   * dashboard endpoint serves (gap #25 slice 1).
   *
   * Includes per-agent elapsed + heartbeat staleness + idle flag, plus
   * aggregate concurrency stats: how many slots are currently busy, the
   * configured max, and how many spawn-queue entries are waiting for a slot.
   * The AbortController is deliberately omitted — snapshots are public,
   * cancellation goes through `kill()` (operator-authenticated).
   *
   * Returns a fresh object each call; the active map is read once at the top
   * so consistency holds even if a sub-agent settles mid-iteration.
   */
  snapshot(): SwarmSnapshot {
    const now = Date.now();
    const active = [...this.active.values()].sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
    );

    const spawned: AgentSnapshot[] = active.map((a) => {
      const sinceHeartbeatMs = now - a.lastHeartbeat;
      return {
        id: a.id,
        task:
          a.task.length > SNAPSHOT_TASK_MAX_CHARS
            ? `${a.task.slice(0, SNAPSHOT_TASK_MAX_CHARS - 1)}…`
            : a.task,
        startedAt: a.startedAt.toISOString(),
        elapsedMs: now - a.startedAt.getTime(),
        sinceHeartbeatMs,
        idle: sinceHeartbeatMs >= IDLE_THRESHOLD_MS,
      };
    });

    // p-queue exposes `size` (pending = waiting to start) and `pending`
    // (currently executing — counts the active task it has handed out).
    // `slotsUsed` = currently-running tasks; `queueWaiting` = awaiting a slot.
    const slotsUsed = this.queue.pending;
    const queueWaiting = this.queue.size;

    return {
      spawned,
      slotsUsed,
      slotsMax: MAX_SWARM_AGENTS,
      queueWaiting,
    };
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
