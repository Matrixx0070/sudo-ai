/**
 * graph-run-schema.ts — DDL and row-to-domain conversion for graph_runs /
 * graph_run_nodes tables (AL4.2 graph-run state store).
 *
 * Kept beside task-queue-schema.ts and follows its conventions exactly:
 * better-sqlite3, idempotent CREATE TABLE IF NOT EXISTS via an exported
 * init function, snake_case columns, TEXT UUID PKs, JSON-as-TEXT, ISO-8601
 * strftime timestamp defaults, CHECK-constrained enums, idx_<abbrev>_<col>
 * indexes. Only imported by graph-run-store.ts.
 */

import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { WorkflowGraph } from '../workflows/graph-types.js';
import type { GraphNodeResult } from '../workflows/graph-run-types.js';

// ---------------------------------------------------------------------------
// Types (re-exported via graph-run-store.ts)
// ---------------------------------------------------------------------------

export type GraphRunStatus =
  | 'running'
  | 'success'
  | 'partial'
  | 'halted'
  | 'awaiting_approval'
  | 'paused';

export type GraphApprovalStatus = 'pending' | 'approved' | 'denied';

/** AL4.4 durable approval artifact — the harness-enforced gate evidence. */
export interface GraphApprovalRecord {
  runId: string;
  nodeId: string;
  status: GraphApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
}

export interface GraphApprovalRow {
  run_id: string;
  node_id: string;
  status: string;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
}

export interface GraphRunRecord {
  runId: string;
  graphName: string;
  /** SHA-256 of the canonical graph JSON — resume refuses on mismatch. */
  graphHash: string;
  status: GraphRunStatus;
  /** Sum of NodeOutcome.spend across the run (tokens; AL4.5 governs limits). */
  budgetSpent: number;
  loopIterations: Record<string, number>;
  startedAt: string;
  updatedAt: string;
}

/** Latest terminal state per (node, most recent record) — resume seed shape. */
export interface GraphRunNodeRecord {
  runId: string;
  nodeId: string;
  status: GraphNodeResult['status'];
  output?: unknown;
  error?: string;
  iteration: number;
  durationMs: number;
  updatedAt: string;
}

export interface GraphRunRow {
  run_id: string;
  graph_name: string;
  graph_hash: string;
  status: string;
  budget_spent: number;
  loop_iterations: string;
  started_at: string;
  updated_at: string;
}

export interface GraphRunNodeRow {
  run_id: string;
  node_id: string;
  status: string;
  output: string | null;
  error: string | null;
  iteration: number;
  duration_ms: number;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Canonical graph hash
// ---------------------------------------------------------------------------

/**
 * SHA-256 over the graph's canonical JSON (stable key order), lowercase hex.
 * Same role as the linear journal's sourceSha256: a resume against an edited
 * graph must refuse rather than replay stale node results.
 */
export function computeGraphHash(graph: WorkflowGraph): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canonical(graph))).digest('hex');
}

// ---------------------------------------------------------------------------
// Schema initialisation (idempotent)
// ---------------------------------------------------------------------------

export function initGraphRunSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_runs (
      run_id          TEXT PRIMARY KEY,
      graph_name      TEXT NOT NULL,
      graph_hash      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','success','partial','halted','awaiting_approval','paused')),
      budget_spent    REAL NOT NULL DEFAULT 0,
      loop_iterations TEXT NOT NULL DEFAULT '{}',
      started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gr_status ON graph_runs(status);
    CREATE INDEX IF NOT EXISTS idx_gr_name   ON graph_runs(graph_name);

    CREATE TABLE IF NOT EXISTS graph_run_nodes (
      run_id      TEXT NOT NULL REFERENCES graph_runs(run_id) ON DELETE CASCADE,
      node_id     TEXT NOT NULL,
      status      TEXT NOT NULL
                  CHECK (status IN ('success','failure','skipped','cancelled','pruned','awaiting_approval')),
      output      TEXT,
      error       TEXT,
      iteration   INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (run_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_grn_run ON graph_run_nodes(run_id);

    CREATE TABLE IF NOT EXISTS graph_run_approvals (
      run_id       TEXT NOT NULL REFERENCES graph_runs(run_id) ON DELETE CASCADE,
      node_id      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','denied')),
      requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      decided_at   TEXT,
      decided_by   TEXT,
      note         TEXT,
      PRIMARY KEY (run_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gra_status ON graph_run_approvals(status);
  `);
}

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function rowToRun(row: GraphRunRow): GraphRunRecord {
  return {
    runId: row.run_id,
    graphName: row.graph_name,
    graphHash: row.graph_hash,
    status: row.status as GraphRunStatus,
    budgetSpent: row.budget_spent,
    loopIterations: parseJson(row.loop_iterations, {}),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

export function rowToApproval(row: GraphApprovalRow): GraphApprovalRecord {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    status: row.status as GraphApprovalStatus,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    note: row.note ?? undefined,
  };
}

export function rowToNode(row: GraphRunNodeRow): GraphRunNodeRecord {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    status: row.status as GraphNodeResult['status'],
    output: parseJson<unknown>(row.output, undefined),
    error: row.error ?? undefined,
    iteration: row.iteration,
    durationMs: row.duration_ms,
    updatedAt: row.updated_at,
  };
}
