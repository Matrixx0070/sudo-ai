/**
 * @file statements.ts
 * @description Prepared statement factory for the spreading-activation network.
 *
 * All SQL is defined here and initialized once per network instance.
 * Keeping SQL isolated from business logic makes both easier to audit.
 *
 * Internal module — not re-exported from index.ts.
 */

import type { Database as BetterSqlite3DB, Statement } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Statement bundle type
// ---------------------------------------------------------------------------

/**
 * All prepared statements used by SpreadingActivationNetwork.
 * Fields are named after their purpose to keep call-sites self-documenting.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface NetworkStatements {
  /**
   * INSERT or UPDATE a concept node, incrementing total_activations on conflict.
   * Params: id, activation, last_activated
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsertNode: Statement<any[], any>;

  /**
   * SELECT a single node by id.
   * Params: id
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNode: Statement<any[], any>;

  /**
   * SELECT all outgoing edges for a node.
   * Params: from_id
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  edgesFrom: Statement<any[], any>;

  /**
   * INSERT an edge if it does not already exist (no-op on duplicate).
   * Params: from_id, to_id, weight
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsertEdge: Statement<any[], any>;

  /**
   * Increase an edge's weight by delta (capped at 1.0) and increment cooccurrences.
   * Params: delta, from_id, to_id
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  strengthenEdge: Statement<any[], any>;

  /**
   * SELECT top-N outgoing edges sorted by weight DESC.
   * Params: from_id, limit
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  edgesRelated: Statement<any[], any>;

  /**
   * UPDATE activation and last_activated for a node without touching total_activations.
   * Params: activation, last_activated, id
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateActivation: Statement<any[], any>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Prepare and return all network statements against the given DB instance.
 * Call once during SpreadingActivationNetwork construction.
 *
 * @param db - Open better-sqlite3 Database instance.
 */
export function buildStatements(db: BetterSqlite3DB): NetworkStatements {
  const upsertNode = db.prepare(`
    INSERT INTO concept_nodes (id, activation, last_activated, total_activations)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      activation        = excluded.activation,
      last_activated    = excluded.last_activated,
      total_activations = total_activations + 1
  `);

  const getNode = db.prepare(`
    SELECT id, activation, last_activated, total_activations
    FROM concept_nodes WHERE id = ?
  `);

  const edgesFrom = db.prepare(`
    SELECT from_id, to_id, weight, cooccurrences
    FROM concept_edges WHERE from_id = ?
  `);

  const upsertEdge = db.prepare(`
    INSERT INTO concept_edges (from_id, to_id, weight)
    VALUES (?, ?, ?)
    ON CONFLICT(from_id, to_id) DO NOTHING
  `);

  const strengthenEdge = db.prepare(`
    UPDATE concept_edges
    SET weight        = MIN(weight + ?, 1.0),
        cooccurrences = cooccurrences + 1
    WHERE from_id = ? AND to_id = ?
  `);

  const edgesRelated = db.prepare(`
    SELECT from_id, to_id, weight, cooccurrences
    FROM concept_edges
    WHERE from_id = ?
    ORDER BY weight DESC
    LIMIT ?
  `);

  const updateActivation = db.prepare(`
    UPDATE concept_nodes
    SET activation = ?, last_activated = ?
    WHERE id = ?
  `);

  return {
    upsertNode,
    getNode,
    edgesFrom,
    upsertEdge,
    strengthenEdge,
    edgesRelated,
    updateActivation,
  };
}
