/**
 * In-process agent mailbox system.
 *
 * Provides point-to-point message passing between named agents within a single
 * SUDO-AI process. Messages are queued per recipient and drained on receive().
 * Listeners are notified synchronously on send().
 *
 * Note: This is intentionally an in-memory system. For cross-process messaging
 * use the AgentMessenger in agents/messenger.ts.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:messaging');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A lightweight message envelope passed between agents.
 * Named MailboxMessage to distinguish from the richer AgentMessage type in
 * agents/types.ts which carries a message-type discriminant and nanoid.
 */
export interface MailboxMessage {
  /** Sender agent ID or logical name, e.g. 'orchestrator'. */
  from: string;
  /** Recipient agent ID or logical name. */
  to: string;
  /** Plain-text message payload. */
  content: string;
  /** ISO-8601 timestamp set at send time. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// AgentMailbox
// ---------------------------------------------------------------------------

class AgentMailbox {
  private queues: Map<string, MailboxMessage[]> = new Map();
  private listeners: Map<string, Array<(msg: MailboxMessage) => void>> = new Map();

  /**
   * Send a message to a recipient agent.
   * Pushes to the recipient's queue and notifies all registered listeners.
   *
   * @param from    - Sender identifier.
   * @param to      - Recipient identifier.
   * @param content - Message payload.
   */
  send(from: string, to: string, content: string): void {
    if (!from || !to) {
      log.warn({ from, to }, 'send: missing from/to — message dropped');
      return;
    }

    const msg: MailboxMessage = {
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
    };

    if (!this.queues.has(to)) {
      this.queues.set(to, []);
    }
    this.queues.get(to)!.push(msg);

    const listeners = this.listeners.get(to) ?? [];
    for (const listener of listeners) {
      listener(msg);
    }

    log.debug({ from, to, contentLength: content.length }, 'Message sent');
  }

  /**
   * Drain and return all queued messages for an agent.
   * Clears the queue after reading.
   *
   * @param agentId - Recipient agent identifier.
   * @returns Array of pending messages (oldest first). Empty when no messages.
   */
  receive(agentId: string): MailboxMessage[] {
    const msgs = this.queues.get(agentId) ?? [];
    this.queues.set(agentId, []);
    log.debug({ agentId, count: msgs.length }, 'Messages received');
    return msgs;
  }

  /**
   * Register a listener that is called synchronously whenever a message
   * arrives for agentId. Multiple listeners are supported per agent.
   *
   * @param agentId - Agent to watch.
   * @param handler - Callback invoked with each incoming message.
   */
  onMessage(agentId: string, handler: (msg: MailboxMessage) => void): void {
    if (!this.listeners.has(agentId)) {
      this.listeners.set(agentId, []);
    }
    this.listeners.get(agentId)!.push(handler);
    log.debug({ agentId }, 'Message listener registered');
  }

  /**
   * Return the number of pending (unread) messages for an agent.
   *
   * @param agentId - Agent identifier to query.
   */
  pendingCount(agentId: string): number {
    return (this.queues.get(agentId) ?? []).length;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/** Shared in-process mailbox instance. Import and use directly. */
export const mailbox = new AgentMailbox();

log.debug('agent-messaging module loaded');
