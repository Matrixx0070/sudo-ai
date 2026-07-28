/**
 * graph-run-store.ts — AL4.2 durable graph-run state store.
 *
 * Persists graph runs beside the task queue (same mind DB conventions):
 * one graph_runs row per run (graph hash, status, budget spent, loop
 * counters) plus one graph_run_nodes row per node's latest terminal state.
 * The graph executor stays storage-agnostic — it emits GraphPersistEvents
 * through an injected callback and accepts a resume seed; this store is the
 * standard implementation of both sides.
 *
 * Resume contract (mirrors the linear journal's sourceSha256 rule): a resume
 * against a graph whose canonical hash differs from the recorded one REFUSES
 * rather than replaying stale node results. Successful nodes seed as settled;
 * failures/prunes/skips re-run (AL2.4 semantics: a recorded failure is not a
 * terminal fact about the world, only about that attempt).
 */

import DatabaseCtor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { WorkflowGraph } from '../workflows/graph-types.js';
import type {
  GraphPersistEvent,
  GraphResumeState,
  GraphRunReport,
} from '../workflows/graph-run-types.js';
import {
  computeGraphHash,
  initGraphRunSchema,
  rowToNode,
  rowToRun,
  type GraphRunNodeRecord,
  type GraphRunNodeRow,
  type GraphRunRecord,
  type GraphRunRow,
} from './graph-run-schema.js';

export { computeGraphHash } from './graph-run-schema.js';
export type { GraphRunRecord, GraphRunNodeRecord, GraphRunStatus } from './graph-run-schema.js';

const log = createLogger('orchestration:graph-run-store');

export class GraphRunStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new DatabaseCtor(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    initGraphRunSchema(this.db);
  }

  /** Register a run (idempotent for the same runId+hash; throws on hash clash). */
  createRun(runId: string, graph: WorkflowGraph): void {
    const hash = computeGraphHash(graph);
    const existing = this.getRun(runId);
    if (existing) {
      if (existing.graphHash !== hash) {
        throw new Error(
          `GraphRunStore: run "${runId}" already exists for a different graph (hash mismatch)`,
        );
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO graph_runs (run_id, graph_name, graph_hash) VALUES (?, ?, ?)`,
      )
      .run(runId, graph.name, hash);
  }

  /**
   * Executor persistence seam — write each event as it happens so a crash
   * loses at most the in-flight nodes. Failures log and continue: the
   * in-memory run stays the source of truth, the store is for recovery.
   */
  persistEvent(runId: string, event: GraphPersistEvent): void {
    try {
      if (event.type === 'node') {
        const r = event.result;
        this.db
          .prepare(
            `INSERT INTO graph_run_nodes (run_id, node_id, status, output, error, iteration, duration_ms, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ON CONFLICT (run_id, node_id) DO UPDATE SET
               status = excluded.status, output = excluded.output, error = excluded.error,
               iteration = excluded.iteration, duration_ms = excluded.duration_ms,
               updated_at = excluded.updated_at`,
          )
          .run(
            runId,
            r.id,
            r.status,
            r.output === undefined ? null : JSON.stringify(r.output),
            r.error ?? null,
            r.iteration,
            r.durationMs,
          );
        if (event.spend !== undefined && event.spend > 0) {
          this.db
            .prepare(`UPDATE graph_runs SET budget_spent = budget_spent + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id = ?`)
            .run(event.spend, runId);
        }
      } else {
        // loop firing: reset node rows in the loop body are superseded by the
        // next iteration's terminal rows; record the counter.
        this.db
          .prepare(
            `UPDATE graph_runs
             SET loop_iterations = json_set(loop_iterations, '$."' || ? || '"', ?),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE run_id = ?`,
          )
          .run(event.edge, event.iteration, runId);
      }
    } catch (err) {
      log.warn(
        { runId, event: event.type, err: err instanceof Error ? err.message : String(err) },
        'persistEvent failed — in-memory run state retained',
      );
    }
  }

  /** Record the final report → terminal run status. */
  finishRun(runId: string, report: GraphRunReport): void {
    this.db
      .prepare(
        `UPDATE graph_runs
         SET status = ?, loop_iterations = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE run_id = ?`,
      )
      .run(report.status, JSON.stringify(report.loopIterations), runId);
  }

  getRun(runId: string): GraphRunRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM graph_runs WHERE run_id = ?`)
      .get(runId) as GraphRunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  getNodes(runId: string): GraphRunNodeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM graph_run_nodes WHERE run_id = ? ORDER BY updated_at, node_id`)
      .all(runId) as GraphRunNodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Build the executor resume seed for a stored run. Refuses when the graph
   * has been edited since the run was recorded (canonical-hash mismatch) or
   * the run is unknown.
   */
  loadResumeState(runId: string, graph: WorkflowGraph): GraphResumeState {
    const run = this.getRun(runId);
    if (!run) throw new Error(`GraphRunStore: unknown run "${runId}"`);
    const hash = computeGraphHash(graph);
    if (hash !== run.graphHash) {
      throw new Error(
        `GraphRunStore: refusing to resume run "${runId}" — graph has changed since the run was recorded ` +
          `(recorded ${run.graphHash.slice(0, 12)}…, current ${hash.slice(0, 12)}…)`,
      );
    }
    return {
      nodes: this.getNodes(runId).map((n) => ({
        id: n.nodeId,
        status: n.status,
        output: n.output,
        iteration: n.iteration,
      })),
      loopIterations: run.loopIterations,
    };
  }

  close(): void {
    this.db.close();
  }
}
