/*
 * TeamBus provides a simple in‑memory message bus and shared workspace
 * for multiple worker threads. It is built on top of Node.js's EventEmitter
 * and uses a lightweight mutex to guarantee that modifications to the
 * internal state (message queues and shared objects) happen atomically.
 *
 * Each agent thread is associated with its own MessagePort. When a
 * worker sends a message, the main thread bus routes that message to
 * the appropriate port. When the bus receives a share or read request
 * from a worker, it updates or returns the shared value respectively.
 *
 * The bus supports both targeted messages (send) and broadcasts
 * (broadcast). It also keeps an inbox per agent that can be drained
 * via readInbox. Agents may store arbitrary data in a shared workspace
 * through the share and read methods. Events are emitted whenever a
 * message is delivered or a value is shared.
 */

import { EventEmitter } from 'events';
import type { MessagePort } from 'worker_threads';

export interface BusMessage {
  from: string;
  to?: string;
  content: string;
  timestamp: number;
}

/**
 * TeamBus is responsible for routing messages between agents and
 * maintaining a shared key/value store. Because the bus operates
 * entirely within the main thread, its internal data structures are
 * protected with a simple async mutex to prevent race conditions when
 * accessed by multiple worker ports concurrently.
 */
export class TeamBus extends EventEmitter {
  // Inbox per agent; messages accumulate here until drained.
  private readonly inboxes: Map<string, BusMessage[]> = new Map();
  // Shared workspace visible to all agents.
  private readonly workspace: Map<string, any> = new Map();
  // Map of agent name → MessagePort for outbound notifications.
  private readonly agentPorts: Map<string, MessagePort> = new Map();
  // Mutex used to serialize access to inboxes and workspace.
  private queue: Promise<void> = Promise.resolve();

  /**
   * Register a worker's message port so the bus can send it
   * notifications. When agents post requests on their port the bus
   * handles those requests here as well.
   */
  registerAgent(name: string, port: MessagePort): void {
    this.agentPorts.set(name, port);
    // Listen for incoming commands from the worker on this port.
    port.on('message', async (msg: any) => {
      // Each message must include an action. Use a mutex around
      // operations that mutate shared state or require a reply to
      // ensure consistency.
      if (!msg || typeof msg !== 'object') return;
      const { id, action } = msg;
      switch (action) {
        case 'send': {
          // send a targeted message from this agent
          const { to, content } = msg;
          await this.send(name, to, content);
          break;
        }
        case 'broadcast': {
          const { content } = msg;
          await this.broadcast(name, content);
          break;
        }
        case 'share': {
          const { key, value } = msg;
          await this.share(key, value);
          break;
        }
        case 'read': {
          const { key } = msg;
          const value = await this.read(key);
          port.postMessage({ id, type: 'response', value });
          break;
        }
        case 'readInbox': {
          // drain this agent's inbox and return messages
          const inbox = await this.readInbox(name);
          port.postMessage({ id, type: 'response', value: inbox });
          break;
        }
        default:
          // Unknown action; ignore silently.
          break;
      }
    });
  }

  /**
   * Internal helper to acquire and release a mutex. The mutex is
   * implemented as a promise queue: each call to lock waits for the
   * previous promise to settle before executing. The returned unlock
   * function should be invoked to allow the next queued operation to
   * run.
   */
  private async lock(): Promise<() => void> {
    let unlock: () => void;
    const next = new Promise<void>(resolve => {
      unlock = resolve;
    });
    const previous = this.queue;
    this.queue = previous.then(() => next);
    await previous;
    return unlock!;
  }

  /**
   * Send a message from one agent to another. The message is queued in
   * the recipient's inbox and also delivered immediately via the
   * recipient's MessagePort if registered. A copy is emitted on the
   * 'message' event.
   */
  async send(from: string, to: string, content: string): Promise<void> {
    const unlock = await this.lock();
    try {
      const timestamp = Date.now();
      const msg: BusMessage = { from, to, content, timestamp };
      const inbox = this.inboxes.get(to) ?? [];
      inbox.push(msg);
      this.inboxes.set(to, inbox);
      const port = this.agentPorts.get(to);
      if (port) {
        port.postMessage({ type: 'message', from, content, timestamp });
      }
      this.emit('message', msg);
    } finally {
      unlock();
    }
  }

  /**
   * Broadcast a message from one agent to all other registered agents.
   * Each recipient gets a copy in its inbox and via its port. The
   * 'broadcast' event is emitted for listeners.
   */
  async broadcast(from: string, content: string): Promise<void> {
    const unlock = await this.lock();
    try {
      const timestamp = Date.now();
      for (const [agent, port] of this.agentPorts.entries()) {
        if (agent === from) continue;
        const msg: BusMessage = { from, to: agent, content, timestamp };
        const inbox = this.inboxes.get(agent) ?? [];
        inbox.push(msg);
        this.inboxes.set(agent, inbox);
        if (port) {
          port.postMessage({ type: 'message', from, content, timestamp });
        }
      }
      this.emit('broadcast', { from, content, timestamp });
    } finally {
      unlock();
    }
  }

  /**
   * Share a value in the global workspace. All agents are notified of
   * the new value. The 'share' event is emitted for listeners.
   */
  async share(key: string, value: any): Promise<void> {
    const unlock = await this.lock();
    try {
      this.workspace.set(key, value);
      for (const port of this.agentPorts.values()) {
        port.postMessage({ type: 'share', key, value });
      }
      this.emit('share', { key, value });
    } finally {
      unlock();
    }
  }

  /**
   * Read a value from the shared workspace. If the key does not
   * exist the result is undefined. This call is synchronous but
   * protected via the same mutex to ensure consistency when
   * interleaved with writes.
   */
  async read(key: string): Promise<any> {
    const unlock = await this.lock();
    try {
      return this.workspace.get(key);
    } finally {
      unlock();
    }
  }

  /**
   * Drain the inbox for the specified agent. Returns all queued
   * messages and clears the inbox. This call is synchronous but
   * protected via the mutex to coordinate with sends and broadcasts.
   */
  async readInbox(agent: string): Promise<BusMessage[]> {
    const unlock = await this.lock();
    try {
      const inbox = this.inboxes.get(agent) ?? [];
      this.inboxes.set(agent, []);
      return inbox;
    } finally {
      unlock();
    }
  }
}