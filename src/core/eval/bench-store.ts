/**
 * @file bench-store.ts
 * @description SQLite-backed storage for BenchResult rows and BenchReport history.
 *
 * Schema: bench_results + bench_reports tables.
 * Uses WAL journal mode for safe concurrent reads.
 * All methods are synchronous (better-sqlite3 API).
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { BenchResult, BenchReport, SkillCondition } from '../shared/wave10-types.js';

const log = createLogger('eval:bench-store');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS bench_results (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  model           TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  condition       TEXT NOT NULL,
  seed_index      INTEGER NOT NULL,
  success         INTEGER NOT NULL,
  latency_ms      REAL NOT NULL,
  cost_usd        REAL NOT NULL,
  complexity_tier TEXT NOT NULL,
  timestamp       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bench_results_run_id    ON bench_results(run_id);
CREATE INDEX IF NOT EXISTS idx_bench_results_model     ON bench_results(model);
CREATE INDEX IF NOT EXISTS idx_bench_results_condition ON bench_results(condition);

CREATE TABLE IF NOT EXISTS bench_reports (
  run_id          TEXT PRIMARY KEY,
  started_at      TEXT NOT NULL,
  completed_at    TEXT NOT NULL,
  total_tasks     INTEGER NOT NULL,
  success_rate    REAL NOT NULL,
  median_latency  REAL NOT NULL,
  p99_latency     REAL NOT NULL,
  total_cost_usd  REAL NOT NULL,
  by_condition    TEXT NOT NULL,
  by_model        TEXT NOT NULL,
  markdown_summary TEXT NOT NULL
);
`;

/**
 * Additive columns introduced in Phase 1 of the eval gate work. Applied via
 * `ensureColumns()` after the base schema runs, so existing databases pick them up
 * with NULL defaults on the next open.
 */
const RESULT_PHASE1_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: 'score',           ddl: 'REAL' },
  { name: 'verifier_type',   ddl: 'TEXT' },
  { name: 'verifier_detail', ddl: 'TEXT' },
  { name: 'strategy',        ddl: 'TEXT' },
  { name: 'tokens',          ddl: 'INTEGER' },
  { name: 'wall_time_ms',    ddl: 'REAL' },
  { name: 'transcript_hash', ddl: 'TEXT' },
];

// ---------------------------------------------------------------------------
// Filter type for listing results
// ---------------------------------------------------------------------------

export interface BenchResultFilter {
  runId?: string;
  model?: string;
  condition?: SkillCondition;
  limit?: number;
}

// ---------------------------------------------------------------------------
// BenchStore
// ---------------------------------------------------------------------------

export class BenchStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath);
      this.db.exec(SCHEMA_SQL);
      this.ensureColumns('bench_results', RESULT_PHASE1_COLUMNS);
      log.info({ dbPath }, 'BenchStore initialised');
    } catch (err) {
      log.error({ err: String(err), dbPath }, 'BenchStore: failed to initialise database');
      throw err;
    }
  }

  /**
   * Idempotently add columns to a table. Used for additive schema migrations —
   * SQLite has no `ADD COLUMN IF NOT EXISTS`, so we introspect PRAGMA table_info first.
   */
  private ensureColumns(table: string, columns: Array<{ name: string; ddl: string }>): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const existing = new Set(rows.map(r => r.name));
    for (const col of columns) {
      if (existing.has(col.name)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.ddl}`);
      log.info({ table, column: col.name }, 'BenchStore: added column via additive migration');
    }
  }

  // ---------------------------------------------------------------------------
  // BenchResult CRUD
  // ---------------------------------------------------------------------------

  /** Insert a single BenchResult row. Throws if id collision. */
  insertResult(r: BenchResult): void {
    try {
      this.db.prepare(INSERT_RESULT_SQL).run(...resultRowParams(r));
    } catch (err) {
      log.error({ err: String(err), id: r.id }, 'BenchStore.insertResult failed');
      throw err;
    }
  }

  /** Batch insert multiple results in a single transaction. */
  insertResults(results: BenchResult[]): void {
    const insert = this.db.prepare(INSERT_RESULT_SQL);
    const tx = this.db.transaction((rows: BenchResult[]) => {
      for (const r of rows) insert.run(...resultRowParams(r));
    });
    tx(results);
    log.info({ count: results.length }, 'BenchStore.insertResults completed');
  }

  /** List results with optional filtering. Default limit: 100. */
  listResults(filter: BenchResultFilter = {}): BenchResult[] {
    const { runId, model, condition, limit = 100 } = filter;
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (runId)     { clauses.push('run_id = ?');    params.push(runId); }
    if (model)     { clauses.push('model = ?');     params.push(model); }
    if (condition) { clauses.push('condition = ?'); params.push(condition); }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql   = `SELECT * FROM bench_results ${where} ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapResultRow);
  }

  // ---------------------------------------------------------------------------
  // BenchReport CRUD
  // ---------------------------------------------------------------------------

  /** Upsert a BenchReport (replaces existing row with same runId). */
  upsertReport(report: BenchReport): void {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO bench_reports
          (run_id, started_at, completed_at, total_tasks, success_rate,
           median_latency, p99_latency, total_cost_usd, by_condition, by_model, markdown_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        report.runId, report.startedAt, report.completedAt, report.totalTasks,
        report.successRate, report.medianLatencyMs, report.p99LatencyMs,
        report.totalCostUsd, JSON.stringify(report.byCondition),
        JSON.stringify(report.byModel), report.markdownSummary,
      );
      log.info({ runId: report.runId }, 'BenchStore.upsertReport completed');
    } catch (err) {
      log.error({ err: String(err), runId: report.runId }, 'BenchStore.upsertReport failed');
      throw err;
    }
  }

  /** Retrieve a single report by runId. Returns null if not found. */
  getReport(runId: string): BenchReport | null {
    const row = this.db.prepare(
      'SELECT * FROM bench_reports WHERE run_id = ?',
    ).get(runId) as Record<string, unknown> | undefined;
    return row ? mapReportRow(row) : null;
  }

  /** List recent reports, newest first. Default limit: 20. */
  listReports(limit = 20): Array<{ runId: string; startedAt: string; totalTasks: number; successRate: number }> {
    const rows = this.db.prepare(
      'SELECT run_id, started_at, total_tasks, success_rate FROM bench_reports ORDER BY started_at DESC LIMIT ?',
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      runId:       String(r['run_id'] ?? ''),
      startedAt:   String(r['started_at'] ?? ''),
      totalTasks:  Number(r['total_tasks'] ?? 0),
      successRate: Number(r['success_rate'] ?? 0),
    }));
  }

  /** Close the underlying database. */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

const INSERT_RESULT_SQL = `
  INSERT INTO bench_results
    (id, run_id, model, agent_id, task_id, condition, seed_index,
     success, latency_ms, cost_usd, complexity_tier, timestamp,
     score, verifier_type, verifier_detail, strategy, tokens, wall_time_ms, transcript_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function resultRowParams(r: BenchResult): unknown[] {
  return [
    r.id, r.runId, r.model, r.agentId, r.taskId, r.condition,
    r.seedIndex, r.success ? 1 : 0, r.latencyMs, r.costUsd,
    r.complexityTier, r.timestamp,
    r.score ?? null,
    r.verifierType ?? null,
    r.verifierDetail ?? null,
    r.strategy ?? null,
    r.tokens ?? null,
    r.wallTimeMs ?? null,
    r.transcriptHash ?? null,
  ];
}

function mapResultRow(r: Record<string, unknown>): BenchResult {
  const row: BenchResult = {
    id:             String(r['id'] ?? ''),
    runId:          String(r['run_id'] ?? ''),
    model:          String(r['model'] ?? ''),
    agentId:        String(r['agent_id'] ?? ''),
    taskId:         String(r['task_id'] ?? ''),
    condition:      String(r['condition'] ?? 'no_skills') as SkillCondition,
    seedIndex:      Number(r['seed_index'] ?? 0),
    success:        Boolean(r['success']),
    latencyMs:      Number(r['latency_ms'] ?? 0),
    costUsd:        Number(r['cost_usd'] ?? 0),
    complexityTier: String(r['complexity_tier'] ?? 'simple') as BenchResult['complexityTier'],
    timestamp:      String(r['timestamp'] ?? ''),
  };
  if (r['score']           !== null && r['score']           !== undefined) row.score          = Number(r['score']);
  if (r['verifier_type']   !== null && r['verifier_type']   !== undefined) row.verifierType   = String(r['verifier_type']);
  if (r['verifier_detail'] !== null && r['verifier_detail'] !== undefined) row.verifierDetail = String(r['verifier_detail']);
  if (r['strategy']        !== null && r['strategy']        !== undefined) row.strategy       = String(r['strategy']);
  if (r['tokens']          !== null && r['tokens']          !== undefined) row.tokens         = Number(r['tokens']);
  if (r['wall_time_ms']    !== null && r['wall_time_ms']    !== undefined) row.wallTimeMs     = Number(r['wall_time_ms']);
  if (r['transcript_hash'] !== null && r['transcript_hash'] !== undefined) row.transcriptHash = String(r['transcript_hash']);
  return row;
}

function mapReportRow(r: Record<string, unknown>): BenchReport {
  return {
    runId:           String(r['run_id'] ?? ''),
    startedAt:       String(r['started_at'] ?? ''),
    completedAt:     String(r['completed_at'] ?? ''),
    totalTasks:      Number(r['total_tasks'] ?? 0),
    successRate:     Number(r['success_rate'] ?? 0),
    medianLatencyMs: Number(r['median_latency'] ?? 0),
    p99LatencyMs:    Number(r['p99_latency'] ?? 0),
    totalCostUsd:    Number(r['total_cost_usd'] ?? 0),
    byCondition:     JSON.parse(String(r['by_condition'] ?? '{}')),
    byModel:         JSON.parse(String(r['by_model'] ?? '{}')),
    markdownSummary: String(r['markdown_summary'] ?? ''),
  };
}
