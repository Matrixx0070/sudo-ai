/**
 * @file agent/a2a-protocol.ts
 * @description A2AProtocol — Agent-to-Agent communication over HTTP.
 *
 * Implements a lightweight subset of the emerging A2A specification:
 *  - Agent cards (capability advertisements)
 *  - Local registry for peer discovery
 *  - POST /a2a/tasks for outbound task delegation
 *  - Inbound task handler registration
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:a2a');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentCard {
  /** Globally unique agent identifier. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Semantic version string (e.g. "1.0.0"). */
  version: string;
  /** List of capability tags this agent exposes (e.g. "code", "research"). */
  capabilities: string[];
  /** HTTP/HTTPS base URL where the agent accepts inbound tasks. */
  endpoint: string;
}

export interface A2ATask {
  /** Unique task ID (assigned by the sender). */
  id: string;
  /** DID or agent ID of the originating agent. */
  fromAgent: string;
  /** Natural-language or structured instruction. */
  instruction: string;
  /** Optional key-value context passed to the receiving agent. */
  context?: Record<string, unknown>;
}

export interface A2AResult {
  /** ID of the task this result corresponds to. */
  taskId: string;
  /** Whether the receiving agent completed or failed the task. */
  status: 'completed' | 'failed';
  /** String output (or error description on failure). */
  output: string;
  /** Optional metadata from the receiving agent. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Protocol defaults
// ---------------------------------------------------------------------------

const TASK_TIMEOUT_MS = 30_000 as const;
const A2A_PATH = '/a2a/tasks' as const;

// ---------------------------------------------------------------------------
// A2AProtocol
// ---------------------------------------------------------------------------

export class A2AProtocol {
  /** Peer registry keyed by agent ID. */
  private readonly registry = new Map<string, AgentCard>();

  /** Optional handler for inbound task requests. */
  private taskHandler: ((task: A2ATask) => Promise<A2AResult>) | null = null;

  /**
   * @param localCard - The AgentCard that describes this agent.
   */
  constructor(private readonly localCard: AgentCard) {
    // Self-register so peers can discover us.
    this.registry.set(localCard.id, localCard);
    log.info({ agentId: localCard.id, name: localCard.name }, 'A2AProtocol initialized');
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  /**
   * Register a remote agent's card in the local peer registry.
   * Overwrites any existing entry with the same ID.
   */
  register(card: AgentCard): void {
    if (!card?.id || !card?.endpoint) {
      throw new TypeError('A2AProtocol.register: card must have id and endpoint');
    }
    this.registry.set(card.id, card);
    log.info({ peerId: card.id, name: card.name, endpoint: card.endpoint }, 'Agent registered');
  }

  /**
   * Remove a peer from the registry.
   *
   * @param agentId - ID of the agent to deregister.
   */
  deregister(agentId: string): void {
    if (this.registry.delete(agentId)) {
      log.info({ agentId }, 'Agent deregistered');
    }
  }

  /**
   * Discover peers that expose a specific capability.
   *
   * @param capability - Capability tag to search for (case-insensitive).
   * @returns Array of matching AgentCards (excluding this agent itself).
   */
  discover(capability: string): AgentCard[] {
    if (!capability) return [];
    const lower = capability.toLowerCase();

    return [...this.registry.values()].filter(
      (card) =>
        card.id !== this.localCard.id &&
        card.capabilities.some((c) => c.toLowerCase() === lower),
    );
  }

  /**
   * Return all registered peer cards, excluding the local agent.
   */
  listPeers(): AgentCard[] {
    return [...this.registry.values()].filter((c) => c.id !== this.localCard.id);
  }

  // -------------------------------------------------------------------------
  // Outbound tasks
  // -------------------------------------------------------------------------

  /**
   * Delegate a task to a remote agent over HTTP POST.
   *
   * Sends `{ ...task }` to `<targetEndpoint>/a2a/tasks` and waits for an
   * A2AResult response. Times out after TASK_TIMEOUT_MS.
   *
   * @param targetEndpoint - Base URL of the receiving agent.
   * @param task - Task payload (id will be auto-assigned).
   * @returns The A2AResult from the remote agent.
   * @throws {Error} on network failure, non-2xx response, or timeout.
   */
  async sendTask(
    targetEndpoint: string,
    task: Omit<A2ATask, 'id'>,
  ): Promise<A2AResult> {
    if (!targetEndpoint) throw new TypeError('sendTask: targetEndpoint is required');
    if (!task?.instruction) throw new TypeError('sendTask: task.instruction is required');

    const fullTask: A2ATask = {
      ...task,
      id: randomUUID(),
      fromAgent: this.localCard.id,
    };

    const url = `${targetEndpoint.replace(/\/$/, '')}${A2A_PATH}`;
    log.info({ taskId: fullTask.id, target: url }, 'Sending A2A task');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullTask),
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ taskId: fullTask.id, target: url, err: msg }, 'A2A task delivery failed');
      throw new Error(`A2A task delivery failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.error(
        { taskId: fullTask.id, status: response.status, body: body.slice(0, 200) },
        'A2A task request returned non-2xx',
      );
      throw new Error(`A2A remote error ${response.status}: ${body.slice(0, 200)}`);
    }

    let result: A2AResult;
    try {
      result = (await response.json()) as A2AResult;
    } catch {
      throw new Error('A2A remote returned non-JSON response');
    }

    if (!result?.taskId || !result?.status) {
      throw new Error('A2A remote returned malformed A2AResult (missing taskId or status)');
    }

    log.info(
      { taskId: fullTask.id, status: result.status },
      'A2A task completed',
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // Inbound tasks
  // -------------------------------------------------------------------------

  /**
   * Register a handler for inbound task requests.
   * Call this before wiring the HTTP route into your server.
   *
   * @param handler - Async function that receives an A2ATask and returns A2AResult.
   */
  setTaskHandler(handler: (task: A2ATask) => Promise<A2AResult>): void {
    if (typeof handler !== 'function') {
      throw new TypeError('setTaskHandler: handler must be a function');
    }
    this.taskHandler = handler;
    log.info({ agentId: this.localCard.id }, 'A2A inbound task handler registered');
  }

  /**
   * Process an inbound task.
   * Intended to be called from your HTTP route handler when a POST arrives
   * at `/a2a/tasks`.
   *
   * @param task - Parsed A2ATask from the request body.
   * @returns A2AResult to send back as the response body.
   */
  async handleInboundTask(task: A2ATask): Promise<A2AResult> {
    if (!task?.id || !task?.instruction) {
      return {
        taskId: task?.id ?? 'unknown',
        status: 'failed',
        output: 'Invalid task: missing id or instruction',
      };
    }

    if (!this.taskHandler) {
      log.warn({ taskId: task.id }, 'A2A inbound task received but no handler registered');
      return {
        taskId: task.id,
        status: 'failed',
        output: 'No task handler registered on this agent',
      };
    }

    log.info({ taskId: task.id, fromAgent: task.fromAgent }, 'Handling inbound A2A task');

    try {
      const result = await this.taskHandler(task);
      log.info({ taskId: task.id, status: result.status }, 'Inbound A2A task handled');
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ taskId: task.id, err: msg }, 'Task handler threw an error');
      return { taskId: task.id, status: 'failed', output: msg };
    }
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Return the local agent's card. */
  getLocalCard(): AgentCard {
    return { ...this.localCard };
  }
}
