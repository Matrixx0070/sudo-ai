/**
 * @file messenger.ts
 * @description In-memory message bus for inter-agent communication.
 *
 * Messages are ephemeral — they exist for the lifetime of a single pipeline
 * run. The orchestrator creates a fresh AgentMessenger for each pipeline and
 * agents read context from it between waves.
 */

import { genId } from '../shared/index.js';
import { createLogger } from '../shared/index.js';
import type { AgentMessage, AgentMessageType } from './types.js';

const log = createLogger('agents:messenger');

// ---------------------------------------------------------------------------
// AgentMessenger
// ---------------------------------------------------------------------------

/**
 * Simple in-memory message store for inter-agent communication.
 *
 * All messages are stored in insertion order. Retrieval is O(n) but n is
 * small (typically < 50 messages per pipeline run).
 */
export class AgentMessenger {
  private readonly messages: AgentMessage[] = [];

  // -------------------------------------------------------------------------
  // Send
  // -------------------------------------------------------------------------

  /**
   * Post a new message to the bus.
   *
   * @param params - Message fields (id and timestamp are auto-generated).
   * @returns The complete AgentMessage with generated id and timestamp.
   */
  send(params: {
    from: string;
    to: string;
    type: AgentMessageType;
    content: string;
  }): AgentMessage {
    const message: AgentMessage = {
      id: genId(),
      from: params.from,
      to: params.to,
      type: params.type,
      content: params.content,
      timestamp: new Date(),
    };

    this.messages.push(message);
    log.debug(
      { messageId: message.id, from: message.from, to: message.to, type: message.type },
      'Message sent',
    );
    return message;
  }

  // -------------------------------------------------------------------------
  // Retrieval
  // -------------------------------------------------------------------------

  /**
   * Get all messages addressed to a specific agent, including broadcasts.
   *
   * @param agentId - The agent ID to retrieve messages for.
   * @returns Messages addressed to this agent or to 'all', in chronological order.
   */
  getFor(agentId: string): AgentMessage[] {
    return this.messages.filter(
      (m) => m.to === agentId || m.to === 'all',
    );
  }

  /**
   * Get all messages in the bus, in chronological order.
   *
   * @returns All messages.
   */
  getAll(): AgentMessage[] {
    return [...this.messages];
  }

  /**
   * Get only broadcast messages (to === 'all').
   *
   * @returns Broadcast messages in chronological order.
   */
  getBroadcasts(): AgentMessage[] {
    return this.messages.filter((m) => m.to === 'all');
  }

  /**
   * Get messages sent by a specific agent.
   *
   * @param agentId - The sender agent ID.
   * @returns Messages from this agent in chronological order.
   */
  getFrom(agentId: string): AgentMessage[] {
    return this.messages.filter((m) => m.from === agentId);
  }

  // -------------------------------------------------------------------------
  // Context building
  // -------------------------------------------------------------------------

  /**
   * Build a natural-language context string from all messages relevant to an
   * agent. Used to inject prior-wave results into a new agent's task prompt.
   *
   * @param agentId - The agent ID to build context for.
   * @returns Formatted context string, or empty string if no messages.
   */
  buildContext(agentId: string): string {
    const relevant = this.getFor(agentId);
    if (relevant.length === 0) return '';

    const lines = relevant.map((m) => {
      const label = m.type === 'result' ? 'RESULT' :
                    m.type === 'error'  ? 'ERROR'  :
                    m.type === 'directive' ? 'DIRECTIVE' : 'CONTEXT';
      return `[${label} from ${m.from}]:\n${m.content}`;
    });

    return `--- CONTEXT FROM PRIOR AGENTS ---\n${lines.join('\n\n')}\n--- END CONTEXT ---`;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Remove all messages. Called between pipeline runs. */
  clear(): void {
    const count = this.messages.length;
    this.messages.length = 0;
    if (count > 0) {
      log.debug({ cleared: count }, 'Message bus cleared');
    }
  }

  /** Number of messages currently stored. */
  get size(): number {
    return this.messages.length;
  }
}
