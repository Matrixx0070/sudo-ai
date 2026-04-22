/**
 * @file commentary.ts
 * @description Two-channel output system — commentary (progress/thinking) and final.
 *
 * Inspired by Codex GPT-5.4's dual-channel output model. The commentary channel
 * streams intermediate progress updates during long-running tasks so the user
 * receives live feedback rather than silence followed by a wall of text.
 *
 * Usage:
 *   import { commentary } from './commentary.js';
 *   commentary.progress('Scanning 47 files...');
 *   commentary.discovery('Found circular dependency in src/core/agent/loop.ts');
 *   commentary.final('Refactor complete — 3 files modified.');
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:commentary');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The kind of commentary message being emitted. */
export type CommentaryType = 'progress' | 'thinking' | 'plan' | 'discovery' | 'final';

/** A single structured message on the commentary channel. */
export interface CommentaryMessage {
  /** Category of this message. */
  type: CommentaryType;
  /** Human-readable content of the update. */
  content: string;
  /** ISO-8601 timestamp set at emit time. */
  timestamp: string;
}

/** Listener callback registered via onMessage(). */
type CommentaryListener = (msg: CommentaryMessage) => void;

// ---------------------------------------------------------------------------
// CommentaryChannel
// ---------------------------------------------------------------------------

/**
 * In-process event bus for agent progress updates.
 *
 * - Messages are buffered in `messages` for replay (e.g. tests, late subscribers).
 * - Listeners are called synchronously on each emit — keep them fast.
 * - The singleton `commentary` is the primary interface; a fresh instance can be
 *   created per-agent-run when isolation is required.
 */
export class CommentaryChannel {
  private messages: CommentaryMessage[] = [];
  private listeners: CommentaryListener[] = [];

  /** Epoch ms of the most recent emit — useful for throttle checks. */
  private lastUpdate = 0;

  // ---------------------------------------------------------------------------
  // Emit helpers
  // ---------------------------------------------------------------------------

  /** Send a progress update (should happen roughly every 30 s on long tasks). */
  progress(content: string): void {
    this.emit({ type: 'progress', content, timestamp: new Date().toISOString() });
  }

  /** Emit an internal reasoning step that the agent is working through. */
  thinking(content: string): void {
    this.emit({ type: 'thinking', content, timestamp: new Date().toISOString() });
  }

  /** Broadcast the step-by-step plan before execution begins. */
  plan(content: string): void {
    this.emit({ type: 'plan', content, timestamp: new Date().toISOString() });
  }

  /** Signal a relevant finding made during investigation or research. */
  discovery(content: string): void {
    this.emit({ type: 'discovery', content, timestamp: new Date().toISOString() });
  }

  /** Emit the definitive end-of-task summary on the final channel. */
  final(content: string): void {
    this.emit({ type: 'final', content, timestamp: new Date().toISOString() });
  }

  // ---------------------------------------------------------------------------
  // Subscription API
  // ---------------------------------------------------------------------------

  /**
   * Register a listener that is called on every future message.
   * Listeners are NOT called for messages emitted before registration.
   * To replay history, call getHistory() separately.
   *
   * @param listener - Callback invoked with each CommentaryMessage.
   */
  onMessage(listener: CommentaryListener): void {
    if (typeof listener !== 'function') {
      log.warn('onMessage: listener must be a function — ignoring');
      return;
    }
    this.listeners.push(listener);
  }

  /**
   * Remove a previously registered listener.
   * No-ops silently if the listener is not registered.
   *
   * @param listener - The exact function reference passed to onMessage().
   */
  offMessage(listener: CommentaryListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1) {
      this.listeners.splice(idx, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Inspection API
  // ---------------------------------------------------------------------------

  /**
   * Return a snapshot of all messages emitted so far.
   * Returns a shallow copy — mutating the array does not affect internal state.
   */
  getHistory(): CommentaryMessage[] {
    return [...this.messages];
  }

  /** Epoch ms of the last emitted message (0 when no messages yet). */
  getLastUpdateTime(): number {
    return this.lastUpdate;
  }

  /** Reset the channel — clears history and removes all listeners. */
  clear(): void {
    this.messages = [];
    this.listeners = [];
    this.lastUpdate = 0;
    log.debug('CommentaryChannel cleared');
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private emit(msg: CommentaryMessage): void {
    if (!msg.content?.trim()) {
      log.warn({ type: msg.type }, 'commentary.emit: empty content — skipping');
      return;
    }

    this.messages.push(msg);
    this.lastUpdate = Date.now();

    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (err) {
        log.warn({ type: msg.type, err: String(err) }, 'Commentary listener threw — continuing');
      }
    }

    log.debug({ type: msg.type }, msg.content);
  }
}

// ---------------------------------------------------------------------------
// Singleton — default export for convenience
// ---------------------------------------------------------------------------

/** Process-wide commentary channel. Import and use directly for most cases. */
export const commentary = new CommentaryChannel();
