/**
 * gateway/progress.ts
 *
 * Standalone progress broadcaster module.
 * Channels (Telegram, CLI, etc.) subscribe to a sessionId and receive
 * live events as the gateway processes a request.
 *
 * Usage:
 *   import { progress } from '../gateway/progress.js';
 *
 *   const unsub = progress.subscribe(sessionId, (event) => { ... });
 *   // later:
 *   unsub();
 */

export type ProgressEventType =
  | 'start'
  | 'thinking'
  | 'streaming'
  | 'tool_call'
  | 'complete'
  | 'error';

export interface ProgressEvent {
  type: ProgressEventType;
  sessionId: string;
  message: string;
  timestamp: number;
  provider?: string;
  tokensGenerated?: number;
  elapsedMs?: number;
}

/** Wildcard session ID — subscribe to receive ALL events from ALL sessions. */
export const WILDCARD_SESSION = '*';

export class ProgressBroadcaster {
  private readonly listeners = new Map<string, Set<(event: ProgressEvent) => void>>();

  /**
   * Subscribe to progress events for a given sessionId.
   * Use WILDCARD_SESSION ('*') to receive events for all sessions.
   *
   * @returns An unsubscribe function — call it to stop receiving events.
   */
  subscribe(sessionId: string, listener: (event: ProgressEvent) => void): () => void {
    if (!sessionId) throw new TypeError('subscribe: sessionId must not be empty');
    if (typeof listener !== 'function') throw new TypeError('subscribe: listener must be a function');

    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);

    return () => {
      const s = this.listeners.get(sessionId);
      if (s) {
        s.delete(listener);
        if (s.size === 0) this.listeners.delete(sessionId);
      }
    };
  }

  /**
   * Emit an event to all listeners for the event's sessionId
   * AND all wildcard ('*') listeners.
   * Errors thrown by individual listeners are caught and ignored.
   */
  emit(event: ProgressEvent): void {
    if (!event || !event.sessionId) return;

    const targets = [
      this.listeners.get(event.sessionId),
      this.listeners.get(WILDCARD_SESSION),
    ];

    for (const set of targets) {
      if (!set) continue;
      for (const fn of set) {
        try {
          fn(event);
        } catch {
          // Individual listener errors must never crash the broadcaster
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Convenience methods
  // -------------------------------------------------------------------------

  start(sessionId: string, message = 'Processing...'): void {
    this.emit({ type: 'start', sessionId, message, timestamp: Date.now() });
  }

  thinking(sessionId: string, provider?: string): void {
    this.emit({
      type: 'thinking',
      sessionId,
      message: 'Thinking...',
      timestamp: Date.now(),
      provider,
    });
  }

  streaming(sessionId: string, tokens: number, provider: string): void {
    this.emit({
      type: 'streaming',
      sessionId,
      message: `Streaming (${tokens} tokens)`,
      timestamp: Date.now(),
      provider,
      tokensGenerated: tokens,
    });
  }

  toolCall(sessionId: string, toolName: string, provider?: string): void {
    this.emit({
      type: 'tool_call',
      sessionId,
      message: `Tool call: ${toolName}`,
      timestamp: Date.now(),
      provider,
    });
  }

  complete(sessionId: string, elapsedMs: number, provider?: string): void {
    this.emit({
      type: 'complete',
      sessionId,
      message: 'Done',
      timestamp: Date.now(),
      provider,
      elapsedMs,
    });
  }

  error(sessionId: string, message: string): void {
    this.emit({
      type: 'error',
      sessionId,
      message,
      timestamp: Date.now(),
    });
  }

  /** Count active listener subscriptions (for diagnostics). */
  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

/** Application-wide singleton progress broadcaster. */
export const progress = new ProgressBroadcaster();
