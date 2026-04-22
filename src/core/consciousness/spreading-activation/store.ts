/**
 * @file store.ts
 * @description Persistence helpers for the spreading-activation network.
 *
 * Provides batch-write and bulk-load operations against the `concept_nodes`
 * table via the ConsciousnessDB wrapper. All SQL uses prepared statements
 * and transactions for performance and atomicity.
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessDB } from '../consciousness-db.js';
import { ConsciousnessError } from '../errors.js';
import type { ConceptNode } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('consciousness:spreading-activation');

// ---------------------------------------------------------------------------
// flushActivations
// ---------------------------------------------------------------------------

/**
 * Batch-write all nodes from `nodes` map to the DB in a single transaction.
 * Uses INSERT OR REPLACE so the operation is idempotent and handles both
 * inserts and updates.
 *
 * @param db    - Open ConsciousnessDB instance.
 * @param nodes - In-memory node map to flush.
 * @throws ConsciousnessError on DB write failure.
 */
export function flushActivations(
  db: ConsciousnessDB,
  nodes: Map<string, ConceptNode>,
): void {
  if (nodes.size === 0) return;

  const raw = db.getDb();

  const upsert = raw.prepare<[string, number, string, number]>(`
    INSERT INTO concept_nodes (id, activation, last_activated, total_activations)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      activation        = excluded.activation,
      last_activated    = excluded.last_activated,
      total_activations = excluded.total_activations
  `);

  const flush = raw.transaction((entries: ConceptNode[]) => {
    for (const node of entries) {
      upsert.run(node.id, node.activation, node.lastActivated, node.totalActivations);
    }
  });

  try {
    flush([...nodes.values()]);
    log.debug({ count: nodes.size }, 'Flushed activation nodes to DB');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `flushActivations failed: ${msg}`,
      'consciousness_spreading_flush_failed',
      { count: nodes.size, cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// loadActiveNodes
// ---------------------------------------------------------------------------

/**
 * Load all concept nodes whose activation meets or exceeds `minActivation`.
 * Results are ordered by activation descending so callers get the hottest
 * nodes first.
 *
 * @param db            - Open ConsciousnessDB instance.
 * @param minActivation - Minimum activation threshold (default 0.01).
 * @returns Array of ConceptNode objects hydrated from the DB.
 * @throws ConsciousnessError on DB read failure.
 */
export function loadActiveNodes(
  db: ConsciousnessDB,
  minActivation = 0.01,
): ConceptNode[] {
  if (minActivation < 0 || minActivation > 1) {
    throw new ConsciousnessError(
      `loadActiveNodes: minActivation must be in [0, 1], got ${minActivation}`,
      'consciousness_spreading_invalid_threshold',
      { minActivation },
    );
  }

  const raw = db.getDb();

  const select = raw.prepare<[number], {
    id: string;
    activation: number;
    last_activated: string;
    total_activations: number;
  }>(`
    SELECT id, activation, last_activated, total_activations
    FROM concept_nodes
    WHERE activation >= ?
    ORDER BY activation DESC
  `);

  try {
    const rows = select.all(minActivation);
    const nodes: ConceptNode[] = rows.map((r) => ({
      id: r.id,
      activation: r.activation,
      lastActivated: r.last_activated,
      totalActivations: r.total_activations,
    }));
    log.debug({ count: nodes.length, minActivation }, 'Loaded active nodes from DB');
    return nodes;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `loadActiveNodes failed: ${msg}`,
      'consciousness_spreading_load_failed',
      { minActivation, cause: msg },
    );
  }
}
