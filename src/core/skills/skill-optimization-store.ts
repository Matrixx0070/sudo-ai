/**
 * @file skill-optimization-store.ts
 * @description SQLite-backed store for SkillOptimizationProposal persistence.
 *
 * Separate from ProposalStore (which models agent-wide config deltas).
 * This store is skill-centric (per-field patches, 3-status lifecycle).
 *
 * DB path: data/skill-optimizations.db
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SkillOptimizationProposal, SkillOptimizationStatus } from '../shared/wave10-types.js';
import { createLogger } from '../shared/logger.js';

/**
 * Extended status type that adds 'auto-applied' to the base SkillOptimizationStatus.
 * wave10-types.ts is out-of-boundary so we extend locally here.
 * Internal callers use this type; external callers still see SkillOptimizationStatus
 * via the public SkillOptimizationProposal type.
 */
export type SkillOptimizationStatusFull = SkillOptimizationStatus | 'auto-applied';

const log = createLogger('skills:optimization-store');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA foreign_keys  = ON;

CREATE TABLE IF NOT EXISTS skill_optimizations (
  id              TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL,
  skill_name      TEXT NOT NULL,
  target_field    TEXT NOT NULL CHECK (target_field IN ('description','examples','tags')),
  current_value   TEXT NOT NULL DEFAULT '',
  proposed_value  TEXT NOT NULL DEFAULT '',
  evidence        TEXT NOT NULL DEFAULT '',
  confidence      REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','auto-applied')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_so_status    ON skill_optimizations(status);
CREATE INDEX IF NOT EXISTS idx_so_skill_id  ON skill_optimizations(skill_id);
CREATE INDEX IF NOT EXISTS idx_so_created   ON skill_optimizations(created_at DESC);
`;

/**
 * Idempotent migration: widens the status CHECK constraint to include 'auto-applied'.
 * Required for existing DBs that were created with the narrower constraint.
 *
 * SQLite cannot ALTER a CHECK constraint in-place. We use the standard
 * "12-step ALTER TABLE" approach: create new table, copy data, drop old, rename.
 * Safe to call on both old and new schemas — skipped when auto-applied already allowed.
 */
function applyAutoAppliedMigration(db: Database.Database): void {
  // Probe: attempt insert with 'auto-applied', roll back immediately.
  // If the CHECK passes, migration is not needed (new schema or already migrated).
  try {
    const probeInsert = db.prepare(`INSERT INTO skill_optimizations
      (id, skill_id, skill_name, target_field, current_value, proposed_value,
       evidence, confidence, status, created_at, updated_at)
      VALUES ('__probe__', 'probe', 'probe', 'description', '', '', '', 0,
              'auto-applied', 'probe', 'probe')
    `);
    const probeDelete = db.prepare(`DELETE FROM skill_optimizations WHERE id = '__probe__'`);
    const probeTxn = db.transaction(() => {
      probeInsert.run();
      probeDelete.run();
    });
    probeTxn();
    return;
  } catch {
    // CHECK failed — need migration
  }

  log.info({ event: 'skill-opt-store.migration.auto-applied' },
    'SkillOptimizationStore: widening status CHECK to include auto-applied');

  db.exec(`
    BEGIN;
    CREATE TABLE IF NOT EXISTS skill_optimizations_v2 (
      id              TEXT PRIMARY KEY,
      skill_id        TEXT NOT NULL,
      skill_name      TEXT NOT NULL,
      target_field    TEXT NOT NULL CHECK (target_field IN ('description','examples','tags')),
      current_value   TEXT NOT NULL DEFAULT '',
      proposed_value  TEXT NOT NULL DEFAULT '',
      evidence        TEXT NOT NULL DEFAULT '',
      confidence      REAL NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','auto-applied')),
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    INSERT INTO skill_optimizations_v2 SELECT * FROM skill_optimizations;
    DROP TABLE skill_optimizations;
    ALTER TABLE skill_optimizations_v2 RENAME TO skill_optimizations;
    CREATE INDEX IF NOT EXISTS idx_so_status   ON skill_optimizations(status);
    CREATE INDEX IF NOT EXISTS idx_so_skill_id ON skill_optimizations(skill_id);
    CREATE INDEX IF NOT EXISTS idx_so_created  ON skill_optimizations(created_at DESC);
    COMMIT;
  `);
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface SkillOptimizationRow {
  id: string;
  skill_id: string;
  skill_name: string;
  target_field: 'description' | 'examples' | 'tags';
  current_value: string;
  proposed_value: string;
  evidence: string;
  confidence: number;
  status: SkillOptimizationStatusFull;
  created_at: string;
  updated_at: string;
}

function rowToProposal(row: SkillOptimizationRow): Omit<SkillOptimizationProposal, 'status'> & { status: SkillOptimizationStatusFull } {
  return {
    id: row.id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    targetField: row.target_field,
    currentValue: row.current_value,
    proposedValue: row.proposed_value,
    evidence: row.evidence,
    confidence: row.confidence,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// SkillOptimizationStore
// ---------------------------------------------------------------------------

export class SkillOptimizationStore {
  private readonly db: Database.Database;

  constructor(dbPath = 'data/skill-optimizations.db') {
    try {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(dbPath);
      this.db.exec(SCHEMA);
      // Widen CHECK constraint to include 'auto-applied' for existing DBs.
      applyAutoAppliedMigration(this.db);
      log.info({ dbPath }, 'SkillOptimizationStore initialised');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`SkillOptimizationStore: failed to open database at ${dbPath}: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Persist a new proposal. Idempotent on duplicate id (insert-or-ignore).
   * Returns the stored proposal.
   */
  save(proposal: SkillOptimizationProposal): SkillOptimizationProposal {
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO skill_optimizations
          (id, skill_id, skill_name, target_field, current_value, proposed_value,
           evidence, confidence, status, created_at, updated_at)
        VALUES
          (:id, :skill_id, :skill_name, :target_field, :current_value, :proposed_value,
           :evidence, :confidence, :status, :created_at, :updated_at)
      `).run({
        id: proposal.id,
        skill_id: proposal.skillId,
        skill_name: proposal.skillName,
        target_field: proposal.targetField,
        current_value: proposal.currentValue,
        proposed_value: proposal.proposedValue,
        evidence: proposal.evidence,
        confidence: proposal.confidence,
        status: proposal.status,
        created_at: proposal.createdAt,
        updated_at: proposal.updatedAt,
      });
      log.info({ id: proposal.id, skillId: proposal.skillId }, 'skill optimization proposal saved');
      return proposal;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, id: proposal.id }, 'SkillOptimizationStore.save failed');
      throw new Error(`SkillOptimizationStore.save failed: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * List proposals with optional status filter, pagination.
   * status may include 'auto-applied' (SkillOptimizationStatusFull extension).
   */
  list(filter: {
    status?: SkillOptimizationStatusFull;
    limit: number;
    offset: number;
  }): { data: SkillOptimizationProposal[]; total: number } {
    try {
      const { status, limit, offset } = filter;
      if (status) {
        const total = (this.db.prepare(
          `SELECT COUNT(*) AS n FROM skill_optimizations WHERE status = ?`,
        ).get(status) as { n: number }).n;
        const rows = this.db.prepare(
          `SELECT * FROM skill_optimizations WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        ).all(status, limit, offset) as SkillOptimizationRow[];
        return { data: rows.map(rowToProposal) as unknown as SkillOptimizationProposal[], total };
      }
      const total = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM skill_optimizations`,
      ).get() as { n: number }).n;
      const rows = this.db.prepare(
        `SELECT * FROM skill_optimizations ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).all(limit, offset) as SkillOptimizationRow[];
      return { data: rows.map(rowToProposal) as unknown as SkillOptimizationProposal[], total };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'SkillOptimizationStore.list failed');
      throw new Error(`SkillOptimizationStore.list failed: ${msg}`);
    }
  }

  /**
   * Get a single proposal by ID. Returns null if not found.
   */
  getById(id: string): SkillOptimizationProposal | null {
    try {
      const row = this.db.prepare(
        `SELECT * FROM skill_optimizations WHERE id = ?`,
      ).get(id) as SkillOptimizationRow | undefined;
      // Cast: SkillOptimizationStatusFull is a superset of SkillOptimizationStatus;
      // callers that need 'auto-applied' status must use list() with status filter.
      return row ? (rowToProposal(row) as unknown as SkillOptimizationProposal) : null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, id }, 'SkillOptimizationStore.getById failed');
      throw new Error(`SkillOptimizationStore.getById failed: ${msg}`);
    }
  }

  /**
   * Get the most recently approved proposal for a skill.
   * Returns null if none found.
   */
  getLatestApprovedForSkill(skillId: string): SkillOptimizationProposal | null {
    try {
      const row = this.db.prepare(
        `SELECT * FROM skill_optimizations
         WHERE skill_id = ? AND status = 'approved'
         ORDER BY updated_at DESC LIMIT 1`,
      ).get(skillId) as SkillOptimizationRow | undefined;
      // Cast: row always has status='approved' here, within SkillOptimizationStatus range.
      return row ? (rowToProposal(row) as unknown as SkillOptimizationProposal) : null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, skillId }, 'SkillOptimizationStore.getLatestApprovedForSkill failed');
      throw new Error(`SkillOptimizationStore.getLatestApprovedForSkill failed: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Status transitions
  // ---------------------------------------------------------------------------

  /**
   * Approve a proposal. Throws if not found.
   */
  approve(id: string): SkillOptimizationProposal {
    try {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Proposal not found: ${id}`);
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE skill_optimizations SET status = 'approved', updated_at = ? WHERE id = ?`,
      ).run(now, id);
      return { ...existing, status: 'approved', updatedAt: now };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, id }, 'SkillOptimizationStore.approve failed');
      throw new Error(`SkillOptimizationStore.approve failed: ${msg}`);
    }
  }

  /**
   * Reject a proposal with an optional reason (appended to evidence).
   * Throws if not found.
   */
  reject(id: string, reason?: string): SkillOptimizationProposal {
    try {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Proposal not found: ${id}`);
      const now = new Date().toISOString();
      const updatedEvidence = reason
        ? `${existing.evidence} [REJECTED: ${reason}]`
        : existing.evidence;
      this.db.prepare(
        `UPDATE skill_optimizations SET status = 'rejected', evidence = ?, updated_at = ? WHERE id = ?`,
      ).run(updatedEvidence, now, id);
      return { ...existing, status: 'rejected', evidence: updatedEvidence, updatedAt: now };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, id }, 'SkillOptimizationStore.reject failed');
      throw new Error(`SkillOptimizationStore.reject failed: ${msg}`);
    }
  }

  /**
   * Mark a proposal as auto-applied (SkillOptimizer.autoApplyApproved).
   * Transitions the status from 'pending' to 'auto-applied'.
   * Throws if not found.
   */
  markAutoApplied(id: string): Omit<SkillOptimizationProposal, 'status'> & { status: SkillOptimizationStatusFull } {
    try {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Proposal not found: ${id}`);
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE skill_optimizations SET status = 'auto-applied', updated_at = ? WHERE id = ?`,
      ).run(now, id);
      log.info({ id, skillId: existing.skillId }, 'SkillOptimizationStore: proposal marked auto-applied');
      return { ...existing, status: 'auto-applied' as SkillOptimizationStatusFull, updatedAt: now };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, id }, 'SkillOptimizationStore.markAutoApplied failed');
      throw new Error(`SkillOptimizationStore.markAutoApplied failed: ${msg}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    try {
      this.db.close();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'SkillOptimizationStore.close: error closing DB');
    }
  }
}
