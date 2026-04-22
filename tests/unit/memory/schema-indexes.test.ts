/**
 * @file schema-indexes.test.ts
 * @description Verify that all compound indexes added in the security-debt-sweep
 * (Items 9, 10b, 11) are created by initializeSchema() on an in-memory DB.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../../src/core/memory/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initializeSchema(db);
  return db;
}

/**
 * Query sqlite_master for all indexes on a given table and return their names.
 */
function indexNamesForTable(db: Database.Database, tableName: string): string[] {
  const rows = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`,
    )
    .all(tableName);
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('schema compound indexes (security-debt-sweep)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  // -------------------------------------------------------------------------
  // Item 9 — video_metrics compound index
  // -------------------------------------------------------------------------
  describe('video_metrics', () => {
    it('has idx_video_metrics_video_id_id compound index', () => {
      const names = indexNamesForTable(db, 'video_metrics');
      expect(names).toContain('idx_video_metrics_video_id_id');
    });

    it('also retains existing single-column indexes', () => {
      const names = indexNamesForTable(db, 'video_metrics');
      expect(names).toContain('idx_video_metrics_video_id');
      expect(names).toContain('idx_video_metrics_channel');
      expect(names).toContain('idx_video_metrics_snapshot_at');
    });
  });

  // -------------------------------------------------------------------------
  // Item 10b — api_costs compound index
  // -------------------------------------------------------------------------
  describe('api_costs', () => {
    it('has idx_api_costs_provider_created_at compound index', () => {
      const names = indexNamesForTable(db, 'api_costs');
      expect(names).toContain('idx_api_costs_provider_created_at');
    });

    it('also retains existing single-column indexes', () => {
      const names = indexNamesForTable(db, 'api_costs');
      expect(names).toContain('idx_api_costs_provider');
      expect(names).toContain('idx_api_costs_model');
      expect(names).toContain('idx_api_costs_session_id');
      expect(names).toContain('idx_api_costs_created_at');
    });
  });

  // -------------------------------------------------------------------------
  // Item 11 — cron_runs compound indexes
  // -------------------------------------------------------------------------
  describe('cron_runs', () => {
    it('has idx_cron_runs_status_ran_at compound index', () => {
      const names = indexNamesForTable(db, 'cron_runs');
      expect(names).toContain('idx_cron_runs_status_ran_at');
    });

    it('has idx_cron_runs_job_name_ran_at compound index', () => {
      const names = indexNamesForTable(db, 'cron_runs');
      expect(names).toContain('idx_cron_runs_job_name_ran_at');
    });

    it('also retains existing single-column indexes', () => {
      const names = indexNamesForTable(db, 'cron_runs');
      expect(names).toContain('idx_cron_runs_job_name');
      expect(names).toContain('idx_cron_runs_status');
      expect(names).toContain('idx_cron_runs_ran_at');
    });
  });
});
