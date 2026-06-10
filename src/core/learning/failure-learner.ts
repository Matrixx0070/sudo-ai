/**
 * @file failure-learner.ts
 * @description Upgrade 66 — Learning From Failures.
 *
 * Stores a per-tool failure log with deduplication support.
 * When a solution is discovered it is saved as a prevention rule so future
 * calls can short-circuit and avoid repeating the same mistake.
 *
 * Storage: in-memory by default (process-lifetime, legacy behavior unchanged).
 * Opt-in durable mode via SUDO_FAILURE_LEARNER_DB=1 (default OFF) persists to
 * the shared mind.db SQLite instance so rules/solutions survive restarts.
 * Fail-open at init: if the database cannot be opened the learner falls back
 * to the in-memory store. Runtime DB errors propagate to callers (consistent
 * with FeedbackMemory/Predictor; ToolOutcomeLearner already wraps calls).
 * Store implementations live in failure-learner-store.ts (300-line rule).
 */

import { createLogger } from '../shared/logger.js';
import { MIND_DB } from '../shared/paths.js';
import {
  MemoryFailureStore, SqliteFailureStore, errorKey,
  type FailureStore, type FailureRecord,
} from './failure-learner-store.js';

export type { FailureRecord } from './failure-learner-store.js';

const log = createLogger('learning:failures');

// ---------------------------------------------------------------------------
// Store selection (lazy; flag read at first use)
// ---------------------------------------------------------------------------

let store: FailureStore | null = null;

function getStore(): FailureStore {
  if (!store) {
    if (process.env['SUDO_FAILURE_LEARNER_DB'] === '1') {
      try {
        store = new SqliteFailureStore(MIND_DB);
        log.info({ db: MIND_DB }, 'FailureLearner using durable SQLite store');
      } catch (err) {
        log.warn({ err: String(err) }, 'FailureLearner SQLite store unavailable — falling back to in-memory');
        store = new MemoryFailureStore();
      }
    } else {
      store = new MemoryFailureStore();
    }
  }
  return store;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a new failure for a given tool.
 * The per-tool list is capped at MAX_PER_TOOL; oldest entries are evicted.
 */
export function recordFailure(tool: string, error: string, context: string): FailureRecord {
  if (!tool)    throw new TypeError('tool is required');
  if (!error)   throw new TypeError('error is required');
  if (!context) throw new TypeError('context is required');

  const record: FailureRecord = {
    id: `fail-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    tool,
    error,
    context,
    occurredAt: new Date().toISOString(),
  };

  getStore().insert(record);
  log.warn({ tool, error: error.substring(0, 80) }, 'Failure recorded');
  return record;
}

/**
 * Attach a solution and optional prevention rule to an existing failure record.
 * If a prevention rule is provided it is indexed for fast future lookup.
 */
export function recordSolution(
  failureId: string,
  solution: string,
  preventionRule?: string,
): void {
  if (!failureId) throw new TypeError('failureId is required');
  if (!solution)  throw new TypeError('solution is required');

  const resolved = getStore().resolve(failureId, solution, preventionRule, new Date().toISOString());
  if (!resolved) {
    log.warn({ failureId }, 'recordSolution: failure not found');
    return;
  }
  if (preventionRule) log.info({ tool: resolved.tool }, 'Prevention rule stored');
}

/** Retrieve the prevention rule for a tool+error combination (if known). */
export function getPreventionRule(tool: string, error: string): string | undefined {
  return getStore().getPreventionRule(errorKey(tool, error));
}

/** Returns true if an identical (tool, error prefix) failure has been seen before. */
export function hasSeenBefore(tool: string, error: string): boolean {
  return getStore().hasErrorPrefix(tool, error.substring(0, 30));
}

/**
 * Return the previously discovered solution for a tool+error, if one was recorded.
 */
export function getSolution(tool: string, error: string): string | undefined {
  return getStore().findSolutionByErrorPrefix(tool, error.substring(0, 30));
}

/** Per-tool failure counts. */
export function getFailureStats(): Record<string, number> {
  return getStore().stats();
}
