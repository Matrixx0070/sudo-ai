/**
 * @file failure-learner.ts
 * @description Upgrade 66 — Learning From Failures.
 *
 * Stores a per-tool failure log with deduplication support.
 * When a solution is discovered it is saved as a prevention rule so future
 * calls can short-circuit and avoid repeating the same mistake.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('learning:failures');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailureRecord {
  id: string;
  tool: string;
  error: string;
  context: string;
  solution?: string;
  preventionRule?: string;
  occurredAt: string;
  resolvedAt?: string;
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const MAX_PER_TOOL = 200;

/** tool → list of records */
const failures: Map<string, FailureRecord[]> = new Map();

/** `${tool}:${error.slice(0,50)}` → prevention rule */
const preventionRules: Map<string, string> = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorKey(tool: string, error: string): string {
  return `${tool}:${error.substring(0, 50)}`;
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

  if (!failures.has(tool)) failures.set(tool, []);
  const bucket = failures.get(tool)!;
  bucket.push(record);
  if (bucket.length > MAX_PER_TOOL) bucket.splice(0, bucket.length - MAX_PER_TOOL);

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

  for (const records of failures.values()) {
    const r = records.find(r => r.id === failureId);
    if (r) {
      r.solution        = solution;
      r.preventionRule  = preventionRule;
      r.resolvedAt      = new Date().toISOString();

      if (preventionRule) {
        preventionRules.set(errorKey(r.tool, r.error), preventionRule);
        log.info({ tool: r.tool }, 'Prevention rule stored');
      }
      return;
    }
  }

  log.warn({ failureId }, 'recordSolution: failure not found');
}

/** Retrieve the prevention rule for a tool+error combination (if known). */
export function getPreventionRule(tool: string, error: string): string | undefined {
  return preventionRules.get(errorKey(tool, error));
}

/** Returns true if an identical (tool, error prefix) failure has been seen before. */
export function hasSeenBefore(tool: string, error: string): boolean {
  const records = failures.get(tool) ?? [];
  const prefix  = error.substring(0, 30);
  return records.some(r => r.error.includes(prefix));
}

/**
 * Return the previously discovered solution for a tool+error, if one was recorded.
 */
export function getSolution(tool: string, error: string): string | undefined {
  const records = failures.get(tool) ?? [];
  const prefix  = error.substring(0, 30);
  return records.find(r => r.error.includes(prefix) && r.solution)?.solution;
}

/** Per-tool failure counts. */
export function getFailureStats(): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const [tool, records] of failures) {
    stats[tool] = records.length;
  }
  return stats;
}
