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
// Row shapes (owned here — the SQL author defines what columns come back)
// ---------------------------------------------------------------------------

export interface ActivationNodeRow {
  id: string;
  activation: number;
  last_activated: string;
  total_activations: number;
}

export interface ActivationEdgeRow {
  from_id: string;
  to_id: string;
  weight: number;
  cooccurrences: number;
}

// ---------------------------------------------------------------------------
// Statement bundle type
// ---------------------------------------------------------------------------

/**
 * All prepared statements used by SpreadingActivationNetwork.
 * Fields are named after their purpose to keep call-sites self-documenting.
 */
export interface NetworkStatements {
  /**
   * INSERT or UPDATE a concept node, incrementing total_activations on conflict.
   * Params: id, activation, last_activated
   */
  upsertNode: Statement<[string, number, string]>;

  /**
   * SELECT a single node by id.
   * Params: id
   */
  getNode: Statement<[string], ActivationNodeRow>;

  /**
   * SELECT all outgoing edges for a node.
   * Params: from_id
   */
  edgesFrom: Statement<[string], ActivationEdgeRow>;

  /**
   * INSERT an edge if it does not already exist (no-op on duplicate).
   * Params: from_id, to_id, weight
   */
  upsertEdge: Statement<[string, string, number]>;

  /**
   * Increase an edge's weight by delta (capped at 1.0) and increment cooccurrences.
   * Params: delta, from_id, to_id
   */
  strengthenEdge: Statement<[number, string, string]>;

  /**
   * SELECT top-N outgoing edges sorted by weight DESC.
   * Params: from_id, limit
   */
  edgesRelated: Statement<[string, number], ActivationEdgeRow>;

  /**
   * UPDATE activation and last_activated for a node without touching total_activations.
   * Params: activation, last_activated, id
   */
  updateActivation: Statement<[number, string, string]>;
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
  const upsertNode = db.prepare<[string, number, string]>(`
    INSERT INTO concept_nodes (id, activation, last_activated, total_activations)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      activation        = excluded.activation,
      last_activated    = excluded.last_activated,
      total_activations = total_activations + 1
  `);

  const getNode = db.prepare<[string], ActivationNodeRow>(`
    SELECT id, activation, last_activated, total_activations
    FROM concept_nodes WHERE id = ?
  `);

  const edgesFrom = db.prepare<[string], ActivationEdgeRow>(`
    SELECT from_id, to_id, weight, cooccurrences
    FROM concept_edges WHERE from_id = ?
  `);

  const upsertEdge = db.prepare<[string, string, number]>(`
    INSERT INTO concept_edges (from_id, to_id, weight)
    VALUES (?, ?, ?)
    ON CONFLICT(from_id, to_id) DO NOTHING
  `);

  const strengthenEdge = db.prepare<[number, string, string]>(`
    UPDATE concept_edges
    SET weight        = MIN(weight + ?, 1.0),
        cooccurrences = cooccurrences + 1
    WHERE from_id = ? AND to_id = ?
  `);

  const edgesRelated = db.prepare<[string, number], ActivationEdgeRow>(`
    SELECT from_id, to_id, weight, cooccurrences
    FROM concept_edges
    WHERE from_id = ?
    ORDER BY weight DESC
    LIMIT ?
  `);

  const updateActivation = db.prepare<[number, string, string]>(`
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
