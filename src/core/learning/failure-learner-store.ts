/**
 * @file failure-learner-store.ts
 * @description Storage backends for the FailureLearner (Upgrade 66).
 *
 * Separated to keep failure-learner.ts under the 300-line module limit.
 * Two implementations of the same FailureStore interface:
 *  - MemoryFailureStore: process-lifetime maps (legacy default behavior).
 *  - SqliteFailureStore: durable mind.db tables, opt-in via
 *    SUDO_FAILURE_LEARNER_DB=1 (selection happens in failure-learner.ts).
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

export const MAX_PER_TOOL = 200;

export function errorKey(tool: string, error: string): string {
  return `${tool}:${error.substring(0, 50)}`;
}

export interface FailureStore {
  insert(record: FailureRecord): void;
  /**
   * Attach solution/rule to a record; returns the updated record or undefined
   * if not found. Contract (legacy parity): the record's own preventionRule
   * field is overwritten (possibly to undefined), but the indexed rule lookup
   * is only ever written when a rule is provided — a later rule-less resolve
   * does NOT retract a previously indexed rule.
   */
  resolve(
    failureId: string,
    solution: string,
    preventionRule: string | undefined,
    resolvedAt: string,
  ): FailureRecord | undefined;
  getPreventionRule(key: string): string | undefined;
  /** First (oldest) recorded solution whose error contains the prefix. */
  findSolutionByErrorPrefix(tool: string, prefix: string): string | undefined;
  hasErrorPrefix(tool: string, prefix: string): boolean;
  stats(): Record<string, number>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (legacy default)
// ---------------------------------------------------------------------------

export class MemoryFailureStore implements FailureStore {
  private readonly failures = new Map<string, FailureRecord[]>();
  private readonly preventionRules = new Map<string, string>();

  insert(record: FailureRecord): void {
    if (!this.failures.has(record.tool)) this.failures.set(record.tool, []);
    const bucket = this.failures.get(record.tool)!;
    bucket.push(record);
    if (bucket.length > MAX_PER_TOOL) bucket.splice(0, bucket.length - MAX_PER_TOOL);
  }

  resolve(
    failureId: string,
    solution: string,
    preventionRule: string | undefined,
    resolvedAt: string,
  ): FailureRecord | undefined {
    for (const records of this.failures.values()) {
      const r = records.find(rec => rec.id === failureId);
      if (r) {
        r.solution = solution;
        r.preventionRule = preventionRule;
        r.resolvedAt = resolvedAt;
        if (preventionRule) this.preventionRules.set(errorKey(r.tool, r.error), preventionRule);
        return r;
      }
    }
    return undefined;
  }

  getPreventionRule(key: string): string | undefined {
    return this.preventionRules.get(key);
  }

  findSolutionByErrorPrefix(tool: string, prefix: string): string | undefined {
    const records = this.failures.get(tool) ?? [];
    return records.find(r => r.error.includes(prefix) && r.solution)?.solution;
  }

  hasErrorPrefix(tool: string, prefix: string): boolean {
    return (this.failures.get(tool) ?? []).some(r => r.error.includes(prefix));
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [tool, records] of this.failures) out[tool] = records.length;
    return out;
  }
}

// ---------------------------------------------------------------------------
// SQLite implementation (opt-in, durable)
// ---------------------------------------------------------------------------

interface FailureRow {
  id: string;
  tool: string;
  error: string;
  context: string;
  solution: string | null;
  prevention_rule: string | null;
  occurred_at: string;
  resolved_at: string | null;
}

function rowToRecord(r: FailureRow): FailureRecord {
  return {
    id: r.id,
    tool: r.tool,
    error: r.error,
    context: r.context,
    solution: r.solution ?? undefined,
    preventionRule: r.prevention_rule ?? undefined,
    occurredAt: r.occurred_at,
    resolvedAt: r.resolved_at ?? undefined,
  };
}

export class SqliteFailureStore implements FailureStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS failure_log (
        id              TEXT PRIMARY KEY,
        tool            TEXT NOT NULL,
        error           TEXT NOT NULL,
        context         TEXT NOT NULL,
        solution        TEXT,
        prevention_rule TEXT,
        occurred_at     TEXT NOT NULL,
        resolved_at     TEXT
      )
    `);
    // Composite index: the eviction subquery orders by occurred_at within a tool.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_failure_log_tool_time ON failure_log(tool, occurred_at)`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS failure_prevention_rules (
        key        TEXT PRIMARY KEY,
        rule       TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
  }

  insert(record: FailureRecord): void {
    this.db.prepare(`
      INSERT INTO failure_log (id, tool, error, context, occurred_at)
      VALUES (@id, @tool, @error, @context, @occurredAt)
    `).run({
      id: record.id, tool: record.tool, error: record.error,
      context: record.context, occurredAt: record.occurredAt,
    });
    // Enforce the per-tool cap (mirror of the in-memory eviction).
    this.db.prepare(`
      DELETE FROM failure_log
      WHERE tool = @tool AND id NOT IN (
        SELECT id FROM failure_log WHERE tool = @tool
        ORDER BY occurred_at DESC, rowid DESC LIMIT ${MAX_PER_TOOL}
      )
    `).run({ tool: record.tool });
  }

  resolve(
    failureId: string,
    solution: string,
    preventionRule: string | undefined,
    resolvedAt: string,
  ): FailureRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM failure_log WHERE id = ?`)
      .get(failureId) as FailureRow | undefined;
    if (!row) return undefined;

    this.db.prepare(`
      UPDATE failure_log
      SET solution = @solution, prevention_rule = @preventionRule, resolved_at = @resolvedAt
      WHERE id = @id
    `).run({ id: failureId, solution, preventionRule: preventionRule ?? null, resolvedAt });

    if (preventionRule) {
      this.db.prepare(`
        INSERT INTO failure_prevention_rules (key, rule, updated_at)
        VALUES (@key, @rule, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(key) DO UPDATE SET
          rule = excluded.rule, updated_at = excluded.updated_at
      `).run({ key: errorKey(row.tool, row.error), rule: preventionRule });
    }
    return rowToRecord({ ...row, solution, prevention_rule: preventionRule ?? null, resolved_at: resolvedAt });
  }

  getPreventionRule(key: string): string | undefined {
    const row = this.db.prepare(`SELECT rule FROM failure_prevention_rules WHERE key = ?`)
      .get(key) as { rule: string } | undefined;
    return row?.rule;
  }

  findSolutionByErrorPrefix(tool: string, prefix: string): string | undefined {
    // instr() avoids LIKE-escaping issues with % and _ in error text.
    const row = this.db.prepare(`
      SELECT solution FROM failure_log
      WHERE tool = ? AND solution IS NOT NULL AND instr(error, ?) > 0
      ORDER BY occurred_at ASC, rowid ASC LIMIT 1
    `).get(tool, prefix) as { solution: string } | undefined;
    return row?.solution;
  }

  hasErrorPrefix(tool: string, prefix: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM failure_log WHERE tool = ? AND instr(error, ?) > 0 LIMIT 1
    `).get(tool, prefix) !== undefined;
  }

  stats(): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT tool, COUNT(*) AS cnt FROM failure_log GROUP BY tool
    `).all() as Array<{ tool: string; cnt: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.tool] = r.cnt;
    return out;
  }
}
