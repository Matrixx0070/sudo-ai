/**
 * Remote Triggers — scheduled agent execution definitions.
 *
 * Stores cron-based trigger records in memory. A scheduler (external to this
 * module) should call getActiveTriggers() on each tick and dispatch the
 * matching prompt to the agent pipeline.
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';

const log = createLogger('agent:triggers');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemoteTrigger {
  /** Unique identifier, e.g. "trigger-1712345678901". */
  id: string;
  /** Human-readable label shown in the admin UI. */
  name: string;
  /** Standard cron expression, e.g. "0 9 * * 1-5". */
  cron: string;
  /** Prompt text sent to the agent when the trigger fires. */
  prompt: string;
  /** Optional agent type override (e.g. "research", "coding"). */
  agentType?: string;
  /** Whether the trigger is active. Disabled triggers are never dispatched. */
  enabled: boolean;
  /** ISO-8601 timestamp of the last successful fire. */
  lastRun?: string;
  /** ISO-8601 timestamp of the next scheduled fire (populated by scheduler). */
  nextRun?: string;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const triggers: Map<string, RemoteTrigger> = new Map();

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/**
 * Create and register a new remote trigger.
 *
 * @param name      - Human-readable label.
 * @param cron      - Cron schedule string.
 * @param prompt    - Prompt dispatched on fire.
 * @param agentType - Optional agent type override.
 * @returns The newly created trigger.
 * @throws {Error} When name or cron is empty.
 */
export function createTrigger(
  name: string,
  cron: string,
  prompt: string,
  agentType?: string,
): RemoteTrigger {
  if (!name || typeof name !== 'string') {
    throw new Error('createTrigger: name must be a non-empty string');
  }
  if (!cron || typeof cron !== 'string') {
    throw new Error('createTrigger: cron must be a non-empty string');
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('createTrigger: prompt must be a non-empty string');
  }

  const id = `trigger-${genId()}`;
  const trigger: RemoteTrigger = {
    id,
    name,
    cron,
    prompt,
    agentType,
    enabled: true,
  };
  triggers.set(id, trigger);
  log.info({ id, name, cron }, 'Trigger created');
  return trigger;
}

/**
 * Remove a trigger by ID.
 *
 * @param id - Trigger identifier.
 * @returns `true` when deleted, `false` when not found.
 */
export function deleteTrigger(id: string): boolean {
  const deleted = triggers.delete(id);
  if (deleted) {
    log.info({ id }, 'Trigger deleted');
  } else {
    log.warn({ id }, 'deleteTrigger: trigger not found');
  }
  return deleted;
}

/**
 * Return all registered triggers (enabled and disabled).
 */
export function listTriggers(): RemoteTrigger[] {
  return Array.from(triggers.values());
}

/**
 * Enable a trigger so it will fire on schedule.
 *
 * @param id - Trigger identifier.
 */
export function enableTrigger(id: string): void {
  const t = triggers.get(id);
  if (!t) {
    log.warn({ id }, 'enableTrigger: trigger not found');
    return;
  }
  t.enabled = true;
  log.info({ id }, 'Trigger enabled');
}

/**
 * Disable a trigger so it is skipped by the scheduler.
 *
 * @param id - Trigger identifier.
 */
export function disableTrigger(id: string): void {
  const t = triggers.get(id);
  if (!t) {
    log.warn({ id }, 'disableTrigger: trigger not found');
    return;
  }
  t.enabled = false;
  log.info({ id }, 'Trigger disabled');
}

/**
 * Return only triggers that are currently enabled.
 * Used by the scheduler on each cron tick.
 */
export function getActiveTriggers(): RemoteTrigger[] {
  return Array.from(triggers.values()).filter((t) => t.enabled);
}

/**
 * Update lastRun and nextRun timestamps for a trigger after it fires.
 *
 * @param id      - Trigger identifier.
 * @param nextRun - ISO-8601 string for the next scheduled fire.
 */
export function markTriggerFired(id: string, nextRun?: string): void {
  const t = triggers.get(id);
  if (!t) {
    log.warn({ id }, 'markTriggerFired: trigger not found');
    return;
  }
  t.lastRun = new Date().toISOString();
  if (nextRun) t.nextRun = nextRun;
  log.info({ id, lastRun: t.lastRun, nextRun: t.nextRun }, 'Trigger fired');
}
