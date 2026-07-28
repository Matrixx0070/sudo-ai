/**
 * @file self-improvement/retention-ledger.ts
 * @description AL8.4 retention ledger — every ADOPTED improvement gets a
 * durable row: baseline score, candidate score, eval-set hash, adoption PR,
 * revert ref. The quarterly re-check re-validates retained improvements
 * against the CURRENT bench through an injected evaluator:
 *
 *   - evaluator returns null (cannot evaluate) → row SKIPPED, not flagged —
 *     unverifiable is not the same as failing, and flagging without an eval
 *     would be a false accusation;
 *   - current score no longer beats baseline → row FLAGGED for human review.
 *     NEVER auto-reverted (never-drop rule): the flag names the evidence,
 *     a human decides.
 *
 * Rows are append-then-annotate: recheck updates status/timestamps only;
 * adoption facts (scores, hashes, refs) are immutable once recorded.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('self-improvement:retention');

export interface AdoptionRecord {
  proposalId: string;
  artifactType: string;
  baselineScore: number;
  candidateScore: number;
  /** Hash of the eval set the scores came from — same-set comparability. */
  evalSetHash: string;
  /** The human-merged PR (url or number) that adopted the improvement. */
  adoptionPr: string;
  /** How to undo it (revert commit/PR/version id). */
  revertRef: string;
}

export interface RetentionRow extends AdoptionRecord {
  id: number;
  adoptedAt: string;
  lastRecheckAt: string | null;
  recheckStatus: 'ok' | 'flagged';
  flagReason: string | null;
}

interface RawRow {
  id: number;
  proposal_id: string;
  artifact_type: string;
  baseline_score: number;
  candidate_score: number;
  eval_set_hash: string;
  adoption_pr: string;
  revert_ref: string;
  adopted_at: string;
  last_recheck_at: string | null;
  recheck_status: 'ok' | 'flagged';
  flag_reason: string | null;
}

const toRow = (r: RawRow): RetentionRow => ({
  id: r.id,
  proposalId: r.proposal_id,
  artifactType: r.artifact_type,
  baselineScore: r.baseline_score,
  candidateScore: r.candidate_score,
  evalSetHash: r.eval_set_hash,
  adoptionPr: r.adoption_pr,
  revertRef: r.revert_ref,
  adoptedAt: r.adopted_at,
  lastRecheckAt: r.last_recheck_at,
  recheckStatus: r.recheck_status,
  flagReason: r.flag_reason,
});

export class RetentionLedger {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseCtor(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS improvement_retention (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id     TEXT NOT NULL UNIQUE,
        artifact_type   TEXT NOT NULL,
        baseline_score  REAL NOT NULL,
        candidate_score REAL NOT NULL,
        eval_set_hash   TEXT NOT NULL,
        adoption_pr     TEXT NOT NULL,
        revert_ref      TEXT NOT NULL,
        adopted_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_recheck_at TEXT,
        recheck_status  TEXT NOT NULL DEFAULT 'ok' CHECK (recheck_status IN ('ok','flagged')),
        flag_reason     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ir_status ON improvement_retention(recheck_status);
    `);
  }

  /** Record an adoption. Fail-loud on garbage rows — the ledger is evidence. */
  recordAdoption(rec: AdoptionRecord): RetentionRow {
    for (const [k, v] of [['baselineScore', rec.baselineScore], ['candidateScore', rec.candidateScore]] as const) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`RetentionLedger: ${k} must be a finite number (got ${v})`);
      }
    }
    for (const [k, v] of [
      ['proposalId', rec.proposalId], ['evalSetHash', rec.evalSetHash],
      ['adoptionPr', rec.adoptionPr], ['revertRef', rec.revertRef],
    ] as const) {
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new Error(`RetentionLedger: ${k} must be a non-empty string`);
      }
    }
    const info = this.db
      .prepare(`
        INSERT INTO improvement_retention
          (proposal_id, artifact_type, baseline_score, candidate_score, eval_set_hash, adoption_pr, revert_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(rec.proposalId, rec.artifactType, rec.baselineScore, rec.candidateScore,
        rec.evalSetHash, rec.adoptionPr, rec.revertRef);
    log.info({ proposalId: rec.proposalId, pr: rec.adoptionPr }, 'adoption recorded in retention ledger');
    return this.getById(Number(info.lastInsertRowid))!;
  }

  getById(id: number): RetentionRow | undefined {
    const r = this.db.prepare(`SELECT * FROM improvement_retention WHERE id = ?`).get(id) as RawRow | undefined;
    return r ? toRow(r) : undefined;
  }

  list(status?: 'ok' | 'flagged'): RetentionRow[] {
    const rows = (status
      ? this.db.prepare(`SELECT * FROM improvement_retention WHERE recheck_status = ? ORDER BY id`).all(status)
      : this.db.prepare(`SELECT * FROM improvement_retention ORDER BY id`).all()) as RawRow[];
    return rows.map(toRow);
  }

  /**
   * Quarterly re-validation: run every retained row through the injected
   * evaluator (current-bench score for the improvement, or null when it
   * cannot be evaluated). No-longer-beats-baseline → FLAGGED, never reverted.
   */
  async recheck(
    evaluate: (row: RetentionRow) => Promise<number | null>,
  ): Promise<{ checked: number; flagged: RetentionRow[]; skipped: number }> {
    const flagged: RetentionRow[] = [];
    let checked = 0;
    let skipped = 0;
    const now = new Date().toISOString();
    for (const row of this.list()) {
      let current: number | null;
      try {
        current = await evaluate(row);
      } catch (err) {
        current = null;
        log.warn({ proposalId: row.proposalId, err: err instanceof Error ? err.message : String(err) },
          'recheck evaluator threw — row skipped (unverifiable ≠ failing)');
      }
      if (current === null) {
        skipped++;
        continue;
      }
      checked++;
      if (current <= row.baselineScore) {
        const reason = `recheck ${now}: current ${current.toFixed(3)} no longer beats baseline ${row.baselineScore.toFixed(3)}`;
        this.db.prepare(`
          UPDATE improvement_retention
          SET recheck_status = 'flagged', flag_reason = ?, last_recheck_at = ?
          WHERE id = ?
        `).run(reason, now, row.id);
        flagged.push(this.getById(row.id)!);
        log.warn({ proposalId: row.proposalId, reason }, 'retained improvement FLAGGED for human review (never auto-reverted)');
      } else {
        this.db.prepare(`
          UPDATE improvement_retention SET recheck_status = 'ok', last_recheck_at = ? WHERE id = ?
        `).run(now, row.id);
      }
    }
    log.info({ checked, flagged: flagged.length, skipped }, 'retention recheck complete');
    return { checked, flagged, skipped };
  }

  close(): void {
    this.db.close();
  }
}
