/**
 * @file store.ts
 * @description WisdomStore — persistent storage and retrieval of agent insights.
 *
 * Backed by a separate SQLite database (wisdom.db) to keep learning data
 * isolated from the operational mind.db. This makes it easy to:
 *  - Carry wisdom across full resets of mind.db
 *  - Back up / share insights independently
 *  - Inspect the wisdom corpus without touching live session data
 *
 * Uses better-sqlite3 synchronous API throughout.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Insight } from './types.js';

// ---------------------------------------------------------------------------
// Internal row type (snake_case as stored in DB)
// ---------------------------------------------------------------------------

interface InsightRow {
  id: number;
  category: Insight['category'];
  source: Insight['source'];
  insight: string;
  confidence: number;
  applied_count: number;
  created_at: string;
  updated_at: string;
}

function rowToInsight(row: InsightRow): Insight {
  return {
    id:           row.id,
    category:     row.category,
    source:       row.source,
    insight:      row.insight,
    confidence:   row.confidence,
    appliedCount: row.applied_count,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

const WISDOM_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA foreign_keys  = ON;

-- insights
-- Each row is a distilled lesson. Confidence and applied_count evolve over time.
CREATE TABLE IF NOT EXISTS insights (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Lesson classification
  category      TEXT    NOT NULL
                  CHECK (category IN ('error','success','pattern','optimization')),
  source        TEXT    NOT NULL
                  CHECK (source IN ('session','pipeline','analytics','user')),

  -- Human-readable insight text
  insight       TEXT    NOT NULL,

  -- 0..1 confidence estimate
  confidence    REAL    NOT NULL DEFAULT 0.5
                  CHECK (confidence BETWEEN 0 AND 1),

  -- Incremented each time this insight is applied to a task
  applied_count INTEGER NOT NULL DEFAULT 0,

  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS insights_updated_at
  AFTER UPDATE ON insights
  FOR EACH ROW
  BEGIN
    UPDATE insights SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = OLD.id;
  END;

-- FTS5 over insight text for BM25 search
CREATE VIRTUAL TABLE IF NOT EXISTS insights_fts USING fts5(
  insight,
  content = 'insights',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS insights_fts_ai
  AFTER INSERT ON insights BEGIN
    INSERT INTO insights_fts(rowid, insight) VALUES (new.id, new.insight);
  END;

CREATE TRIGGER IF NOT EXISTS insights_fts_ad
  AFTER DELETE ON insights BEGIN
    INSERT INTO insights_fts(insights_fts, rowid, insight)
    VALUES ('delete', old.id, old.insight);
  END;

CREATE TRIGGER IF NOT EXISTS insights_fts_au
  AFTER UPDATE ON insights BEGIN
    INSERT INTO insights_fts(insights_fts, rowid, insight)
    VALUES ('delete', old.id, old.insight);
    INSERT INTO insights_fts(rowid, insight) VALUES (new.id, new.insight);
  END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_insights_category    ON insights(category);
CREATE INDEX IF NOT EXISTS idx_insights_source      ON insights(source);
CREATE INDEX IF NOT EXISTS idx_insights_confidence  ON insights(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_insights_applied_count ON insights(applied_count DESC);
CREATE INDEX IF NOT EXISTS idx_insights_created_at  ON insights(created_at);
`;

// ---------------------------------------------------------------------------
// WisdomStore
// ---------------------------------------------------------------------------

/**
 * Stores and retrieves distilled agent insights across sessions.
 *
 * Usage:
 * ```ts
 * const wisdom = new WisdomStore('<project-root>/data/wisdom.db');
 * const id = wisdom.storeInsight({ ... });
 * const best = wisdom.getTopInsights('success', 5);
 * wisdom.close();
 * ```
 */
export class WisdomStore {
  private readonly db: Database.Database;

  /**
   * @param dbPath - Absolute path to the wisdom SQLite file.
   *                 Defaults to data/wisdom.db relative to cwd.
   */
  constructor(dbPath = 'data/wisdom.db') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this._applySchema();
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private _applySchema(): void {
    // Execute the entire schema as one multi-statement block.
    // The previous split-by-semicolon approach broke trigger statements
    // that contain internal semicolons within their BEGIN...END blocks.
    try {
      this.db.exec(WISDOM_SCHEMA);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already exists')) {
        console.warn(`[WisdomStore] Schema warning: ${msg}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Persist a new insight. Returns the assigned auto-increment ID.
   *
   * @param insight - Partial insight data; id, appliedCount, createdAt, updatedAt
   *                  are all handled by the database automatically.
   */
  storeInsight(
    insight: Pick<Insight, 'category' | 'source' | 'insight'> &
      Partial<Pick<Insight, 'confidence'>>,
  ): number {
    const info = this.db.prepare(`
      INSERT INTO insights (category, source, insight, confidence)
      VALUES (:category, :source, :insight, :confidence)
    `).run({
      category:   insight.category,
      source:     insight.source,
      insight:    insight.insight,
      confidence: insight.confidence ?? 0.5,
    });
    return info.lastInsertRowid as number;
  }

  /**
   * Increment the applied_count for an insight after it has been used in a task.
   * Also optionally adjusts confidence based on outcome.
   *
   * @param id              - Insight primary key
   * @param confidenceDelta - Optional signed adjustment to confidence (-1..+1)
   */
  incrementApplied(id: number, confidenceDelta = 0): void {
    if (confidenceDelta !== 0) {
      // Clamp confidence to [0,1]
      this.db.prepare(`
        UPDATE insights
        SET applied_count = applied_count + 1,
            confidence    = MAX(0.0, MIN(1.0, confidence + :delta))
        WHERE id = :id
      `).run({ id, delta: confidenceDelta });
    } else {
      this.db.prepare(`
        UPDATE insights SET applied_count = applied_count + 1 WHERE id = :id
      `).run({ id });
    }
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * Full-text BM25 search over insight text.
   *
   * @param query - Natural-language search query
   * @param limit - Maximum results (default: 10)
   */
  searchInsights(query: string, limit = 10): Insight[] {
    const sanitised = sanitiseFtsQuery(query);
    if (!sanitised) return [];

    const rows = this.db.prepare<{ query: string; limit: number }, InsightRow>(`
      SELECT i.*
      FROM insights i
      JOIN insights_fts f ON i.id = f.rowid
      WHERE insights_fts MATCH :query
      ORDER BY f.rank
      LIMIT :limit
    `).all({ query: sanitised, limit });

    return rows.map(rowToInsight);
  }

  /**
   * Retrieve the top insights within a category, sorted by combined score
   * (confidence * log(applied_count + 1)) so well-validated insights surface first.
   *
   * @param category - Insight category filter
   * @param limit    - Maximum results (default: 10)
   */
  getTopInsights(category: Insight['category'], limit = 10): Insight[] {
    const rows = this.db.prepare<{ category: string; limit: number }, InsightRow>(`
      SELECT *
      FROM insights
      WHERE category = :category
      ORDER BY (confidence * LOG(applied_count + 2)) DESC
      LIMIT :limit
    `).all({ category, limit });

    return rows.map(rowToInsight);
  }

  /**
   * Retrieve a single insight by primary key. Returns undefined if not found.
   */
  getInsight(id: number): Insight | undefined {
    const row = this.db
      .prepare<{ id: number }, InsightRow>('SELECT * FROM insights WHERE id = :id')
      .get({ id });
    return row ? rowToInsight(row) : undefined;
  }

  /**
   * Retrieve all insights from a given source, newest first.
   *
   * @param source - Source filter
   * @param limit  - Maximum results (default: 50)
   */
  getInsightsBySource(source: Insight['source'], limit = 50): Insight[] {
    const rows = this.db.prepare<{ source: string; limit: number }, InsightRow>(`
      SELECT * FROM insights
      WHERE source = :source
      ORDER BY created_at DESC
      LIMIT :limit
    `).all({ source, limit });
    return rows.map(rowToInsight);
  }

  /**
   * Count total insights, optionally filtered by category.
   */
  count(category?: Insight['category']): number {
    if (category) {
      const row = this.db
        .prepare<{ category: string }, { n: number }>(
          'SELECT COUNT(*) AS n FROM insights WHERE category = :category',
        )
        .get({ category });
      return row?.n ?? 0;
    }
    const row = this.db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM insights')
      .get();
    return row?.n ?? 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Close the database connection cleanly, flushing WAL frames.
   */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sanitiseFtsQuery(raw: string): string {
  const cleaned = raw
    .replace(/[()]/g, ' ')
    .replace(/"/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}
