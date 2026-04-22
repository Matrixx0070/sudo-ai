/**
 * Upgrade 56: ModelEditableContext
 *
 * A key-value store the agent can read and write during its own reasoning loop.
 * Entries are injected as a structured block inside the system prompt so the
 * model always has access to its own dynamic state without needing tool calls.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agent:editable-context');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextEntry {
  id: string;
  key: string;
  value: string;
  setBy: 'user' | 'agent' | 'system';
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

class EditableContext {
  private entries: Map<string, ContextEntry> = new Map();

  /**
   * Set or overwrite a context key.
   *
   * @param key    Identifier (case-sensitive, no whitespace).
   * @param value  String value — complex objects should be JSON.stringify'd.
   * @param setBy  Who is writing the value (defaults to 'agent').
   */
  set(key: string, value: string, setBy: ContextEntry['setBy'] = 'agent'): void {
    if (!key?.trim()) {
      log.warn({ setBy }, 'Attempted to set context with empty key — ignored');
      return;
    }

    const entry: ContextEntry = {
      id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      key: key.trim(),
      value,
      setBy,
      updatedAt: new Date().toISOString(),
    };

    this.entries.set(entry.key, entry);
    log.debug({ key: entry.key, setBy, chars: value.length }, 'Context entry set');
  }

  /**
   * Retrieve a value by key.  Returns undefined when not present.
   */
  get(key: string): string | undefined {
    return this.entries.get(key)?.value;
  }

  /**
   * Remove a key from context.  Returns true if the key existed.
   */
  delete(key: string): boolean {
    const existed = this.entries.has(key);
    if (existed) {
      this.entries.delete(key);
      log.debug({ key }, 'Context entry deleted');
    }
    return existed;
  }

  /**
   * Return all entries as an array (insertion order preserved via Map).
   */
  getAll(): ContextEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Return the number of stored entries.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Build a formatted block suitable for injection into a system prompt.
   * Returns an empty string when there are no entries (no noise for the model).
   */
  toPromptBlock(): string {
    if (this.entries.size === 0) return '';

    const lines = ['# Dynamic Context (agent-managed)'];
    for (const e of this.entries.values()) {
      lines.push(`- ${e.key}: ${e.value}`);
    }
    return lines.join('\n');
  }

  /**
   * Remove all entries.  Useful at the start of a new conversation.
   */
  clear(): void {
    const count = this.entries.size;
    this.entries.clear();
    log.info({ cleared: count }, 'Editable context cleared');
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Process-wide editable context singleton shared by all agent sessions. */
export const editableContext = new EditableContext();
