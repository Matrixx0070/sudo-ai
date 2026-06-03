/**
 * @file push-completion.ts
 * @description PushCompletionBus — EventEmitter-based pub/sub for sub-agent completion events.
 *
 * When a sub-agent completes or fails, it emits an event to notify subscribed parents.
 * One-shot subscriptions: listeners are automatically removed after the event fires.
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '../shared/index.js';

const log = createLogger('agent:push-completion');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Event payload for successful sub-agent completion. */
export interface SubAgentCompleteEvent {
  agentId: string;
  task: string;
  result: string;
  duration: number; // ms
}

/** Event payload for failed sub-agent. */
export interface SubAgentFailedEvent {
  agentId: string;
  task: string;
  error: string;
}

/** Subscription record for tracking parent interest in sub-agent results. */
interface Subscription {
  parentSessionId: string;
  agentId: string;
}

// ---------------------------------------------------------------------------
// PushCompletionBus
// ---------------------------------------------------------------------------

/**
 * EventEmitter-based bus for push-based sub-agent completion notifications.
 *
 * Parents subscribe to specific sub-agent IDs and receive events when
 * the sub-agent completes or fails. Each subscription is one-shot:
 * the listener is automatically removed after the event fires.
 *
 * Events:
 * - 'subagent:complete' — { agentId, task, result, duration }
 * - 'subagent:failed'   — { agentId, task, error }
 */
export class PushCompletionBus extends EventEmitter {
  // Track subscriptions: key = agentId, value = Set of parentSessionIds
  private readonly subscriptions = new Map<string, Set<string>>();

  constructor() {
    super();
    // Allow unlimited listeners — each parent gets its own listener
    this.setMaxListeners(Infinity);
    log.info('PushCompletionBus initialized');
  }

  /**
   * Subscribe a parent agent to receive completion events for a sub-agent.
   * The subscription is one-shot: automatically removed when the event fires.
   *
   * @param parentSessionId - The parent agent's session ID.
   * @param agentId - The sub-agent ID to watch.
   */
  subscribe(parentSessionId: string, agentId: string): void {
    if (!parentSessionId || typeof parentSessionId !== 'string') {
      throw new Error('PushCompletionBus.subscribe: parentSessionId must be a non-empty string');
    }
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('PushCompletionBus.subscribe: agentId must be a non-empty string');
    }

    let agentSubs = this.subscriptions.get(agentId);
    if (!agentSubs) {
      agentSubs = new Set();
      this.subscriptions.set(agentId, agentSubs);
    }
    agentSubs.add(parentSessionId);

    log.debug({ parentSessionId, agentId }, 'Parent subscribed to sub-agent');
  }

  /**
   * Emit a completion event for a sub-agent.
   * Notifies all subscribed parents and cleans up the subscription.
   *
   * @param agentId - The sub-agent ID that completed.
   * @param result - The completion result payload.
   */
  complete(agentId: string, result: SubAgentCompleteEvent): void {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('PushCompletionBus.complete: agentId must be a non-empty string');
    }

    const eventPayload: SubAgentCompleteEvent = {
      agentId,
      task: result.task,
      result: result.result,
      duration: result.duration,
    };

    log.info({ agentId, resultLen: result.result.length, duration: result.duration }, 'Sub-agent completion event');

    // Emit to all subscribers
    this.emit('subagent:complete', eventPayload);

    // Clean up subscriptions for this agent
    this.subscriptions.delete(agentId);
  }

  /**
   * Emit a failure event for a sub-agent.
   * Notifies all subscribed parents and cleans up the subscription.
   *
   * @param agentId - The sub-agent ID that failed.
   * @param error - The error payload.
   */
  fail(agentId: string, error: SubAgentFailedEvent): void {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('PushCompletionBus.fail: agentId must be a non-empty string');
    }

    const eventPayload: SubAgentFailedEvent = {
      agentId,
      task: error.task,
      error: error.error,
    };

    log.warn({ agentId, task: error.task, error: error.error }, 'Sub-agent failure event');

    // Emit to all subscribers
    this.emit('subagent:failed', eventPayload);

    // Clean up subscriptions for this agent
    this.subscriptions.delete(agentId);
  }

  /**
   * Get the list of parent session IDs subscribed to a sub-agent.
   *
   * @param agentId - The sub-agent ID.
   * @returns Array of parent session IDs, or empty array if none.
   */
  getSubscribers(agentId: string): string[] {
    const agentSubs = this.subscriptions.get(agentId);
    return agentSubs ? Array.from(agentSubs) : [];
  }

  /**
   * Check if a sub-agent has any subscribers.
   *
   * @param agentId - The sub-agent ID.
   * @returns True if there are subscribers, false otherwise.
   */
  hasSubscribers(agentId: string): boolean {
    const agentSubs = this.subscriptions.get(agentId);
    return agentSubs ? agentSubs.size > 0 : false;
  }

  /**
   * Get the total number of active subscriptions.
   * Useful for monitoring and debugging.
   */
  get subscriptionCount(): number {
    let count = 0;
    for (const subs of this.subscriptions.values()) {
      count += subs.size;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Singleton instance for global access
// ---------------------------------------------------------------------------

/**
 * Global singleton instance of PushCompletionBus.
 * All agents in the process share this instance.
 */
export const pushCompletionBus = new PushCompletionBus();
