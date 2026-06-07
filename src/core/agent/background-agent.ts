/**
 * @file background-agent.ts
 * @description Upgrade 47 — Background agent execution tracker.
 *
 * Provides a lightweight registry for fire-and-forget agent tasks.
 * Actual execution is the caller's responsibility; this module tracks
 * lifecycle state and delivers completion callbacks.
 */

import { createLogger } from '../shared/logger.js';
import type { HookManager } from '../hooks/index.js';

const log = createLogger('agent:background');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BackgroundStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundAgent {
  id: string;
  prompt: string;
  status: BackgroundStatus;
  result?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  onComplete?: (result: string) => void;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const agents: Map<string, BackgroundAgent> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new background agent task.
 *
 * @param prompt     - Instruction passed to the background execution environment.
 * @param onComplete - Optional callback invoked with the result on completion.
 * @returns The registered BackgroundAgent handle.
 */
export function launchBackground(
  prompt: string,
  onComplete?: (result: string) => void,
): BackgroundAgent {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('launchBackground: prompt is required');
  }

  const agent: BackgroundAgent = {
    id: `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    prompt,
    status: 'running',
    startedAt: new Date().toISOString(),
    onComplete,
  };

  agents.set(agent.id, agent);
  log.info({ id: agent.id, promptLen: prompt.length }, 'Background agent launched');
  return agent;
}

/**
 * Mark a background agent as successfully completed.
 * Invokes the onComplete callback if one was registered.
 *
 * @param id     - Agent ID returned by launchBackground.
 * @param result - The agent's output.
 */
export function completeBackground(id: string, result: string): void {
  const a = agents.get(id);
  if (!a) {
    log.warn({ id }, 'completeBackground: unknown agent id — ignored');
    return;
  }

  a.status = 'completed';
  a.result = result;
  a.completedAt = new Date().toISOString();

  log.info({ id }, 'Background agent completed');

  if (a.onComplete) {
    try {
      a.onComplete(result);
    } catch (err) {
      log.error({ id, err: String(err) }, 'Background agent onComplete callback threw');
    }
  }
}

/**
 * Mark a background agent as failed.
 *
 * @param id    - Agent ID.
 * @param error - Error message or serialised error.
 */
export function failBackground(id: string, error: string): void {
  const a = agents.get(id);
  if (!a) {
    log.warn({ id }, 'failBackground: unknown agent id — ignored');
    return;
  }

  a.status = 'failed';
  a.error = error;
  a.completedAt = new Date().toISOString();
  log.warn({ id, error }, 'Background agent failed');
}

/**
 * Cancel a running background agent.
 * No-ops if the agent has already terminated.
 *
 * @param id - Agent ID.
 */
export function cancelBackground(id: string): void {
  const a = agents.get(id);
  if (!a) {
    log.warn({ id }, 'cancelBackground: unknown agent id — ignored');
    return;
  }

  if (a.status !== 'running') {
    log.debug({ id, status: a.status }, 'cancelBackground: agent not running — skipping');
    return;
  }

  a.status = 'cancelled';
  a.completedAt = new Date().toISOString();
  log.info({ id }, 'Background agent cancelled');
}

/** Retrieve a single background agent by ID. */
export function getBackground(id: string): BackgroundAgent | undefined {
  return agents.get(id);
}

/** Return a snapshot of all background agents. */
export function listBackground(): BackgroundAgent[] {
  return Array.from(agents.values());
}

/** Return only agents that are currently in the 'running' state. */
export function getRunning(): BackgroundAgent[] {
  return Array.from(agents.values()).filter((a) => a.status === 'running');
}

// ---------------------------------------------------------------------------
// BackgroundAgentExecutor — real executor with HookManager integration
// ---------------------------------------------------------------------------

/**
 * Executor that actually runs background agent work via an injected runner
 * function and emits HookManager lifecycle events for observability.
 *
 * Unlike the stateless registry above, this class owns the promise lifecycle
 * and can be used by the boot sequence to wire real AgentLoop execution.
 */
export class BackgroundAgentExecutor {
  private running = new Map<string, { startedAt: number; promise: Promise<string> }>();

  constructor(
    private agentRunner: (sessionId: string, prompt: string) => Promise<string>,
    private hookManager?: HookManager | null,
  ) {
    if (typeof agentRunner !== 'function') {
      throw new TypeError('BackgroundAgentExecutor: agentRunner must be a function');
    }
  }

  /**
   * Dispatch a background agent task and return its tracking ID immediately.
   *
   * @param sessionId  - Session context to run the agent in.
   * @param prompt     - Instruction to pass to the agent runner.
   * @param onComplete - Optional callback invoked with the result on success.
   * @returns Unique tracking ID for this dispatch.
   */
  dispatch(sessionId: string, prompt: string, onComplete?: (result: string) => void): string {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new TypeError('BackgroundAgentExecutor.dispatch: sessionId is required');
    }
    if (!prompt || typeof prompt !== 'string') {
      throw new TypeError('BackgroundAgentExecutor.dispatch: prompt is required');
    }

    const id = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.hookManager?.emit('background:start', {
      event: 'background:start',
      meta: { id, sessionId, prompt: prompt.slice(0, 200) },
    });

    log.info({ id, sessionId, promptLen: prompt.length }, 'BackgroundAgentExecutor: dispatching');

    const promise = Promise.resolve().then(async () => {
      try {
        const result = await this.agentRunner(sessionId, prompt);
        this.hookManager?.emit('background:complete', {
          event: 'background:complete',
          meta: { id, sessionId, success: true },
        });
        log.info({ id, sessionId }, 'BackgroundAgentExecutor: task completed');
        onComplete?.(result);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.hookManager?.emit('background:complete', {
          event: 'background:complete',
          meta: { id, sessionId, success: false, error: message },
        });
        log.error({ id, sessionId, err: message }, 'BackgroundAgentExecutor: task failed');
        throw err;
      } finally {
        this.running.delete(id);
      }
    });

    this.running.set(id, { startedAt: Date.now(), promise });
    return id;
  }

  /**
   * Return a snapshot of all currently in-flight dispatches.
   * The promise itself is not exposed to prevent external settling.
   */
  getRunning(): Array<{ id: string; startedAt: number }> {
    return [...this.running.entries()].map(([id, v]) => ({ id, startedAt: v.startedAt }));
  }
}
