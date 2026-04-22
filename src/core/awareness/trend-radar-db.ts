/**
 * TrendRadarDB — SQLite persistence layer for TrendRadar.
 *
 * Handles:
 *   - Schema creation (trend_radar + trend_alerts tables + indexes)
 *   - Upsert of TrendItem records (INSERT OR IGNORE)
 *   - Insert of TrendAlert records
 *   - Query helpers: getRecentTrends, getAlerts, getStats
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { TrendItem, TrendAlert } from './trend-radar-types.js';

const logger = createLogger('trend-radar-db');

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS trend_radar (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    source        TEXT NOT NULL,
    url           TEXT,
    score         INTEGER NOT NULL DEFAULT 0,
    category      TEXT,
    matches_niche INTEGER NOT NULL DEFAULT 0,
    detected_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    metadata      TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tr_source   ON trend_radar(source)`,
  `CREATE INDEX IF NOT EXISTS idx_tr_detected ON trend_radar(detected_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tr_niche    ON trend_radar(matches_niche)`,
  `CREATE TABLE IF NOT EXISTS trend_alerts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    trend_id         TEXT NOT NULL,
    reason           TEXT NOT NULL,
    suggested_action TEXT NOT NULL,
    urgency          TEXT NOT NULL DEFAULT 'medium',
    acknowledged     INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ta_trend_id   ON trend_alerts(trend_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ta_urgency    ON trend_alerts(urgency)`,
  `CREATE INDEX IF NOT EXISTS idx_ta_created_at ON trend_alerts(created_at)`,
];

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

export interface TrendRow {
  id: string;
  title: string;
  source: string;
  url: string | null;
  score: number;
  category: string | null;
  matches_niche: number;
  detected_at: string;
  metadata: string;
}

export interface AlertRow {
  id: number;
  trend_id: string;
  reason: string;
  suggested_action: string;
  urgency: string;
  acknowledged: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function rowToTrendItem(row: TrendRow): TrendItem {
  return {
    id:           row.id,
    title:        row.title,
    source:       row.source as TrendItem['source'],
    url:          row.url ?? undefined,
    score:        row.score,
    category:     row.category ?? undefined,
    matchesNiche: row.matches_niche === 1,
    detectedAt:   row.detected_at,
    metadata:     safeParseJson(row.metadata),
  };
}

function safeParseJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch { return {}; }
}

// ---------------------------------------------------------------------------
// TrendRadarDB
// ---------------------------------------------------------------------------

export class TrendRadarDB {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('TrendRadarDB: dbPath must be a non-empty string');
    }
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this._initSchema();
    logger.info({ dbPath }, 'TrendRadarDB initialised');
  }

  private _initSchema(): void {
    for (const stmt of SCHEMA_STATEMENTS) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) {
          logger.warn({ msg }, 'TrendRadarDB schema warning');
        }
      }
    }
  }

  /** Upsert trends — ignores conflicts (duplicate id = already stored). */
  storeTrends(trends: TrendItem[]): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO trend_radar
        (id, title, source, url, score, category, matches_niche, detected_at, metadata)
      VALUES
        (:id, :title, :source, :url, :score, :category, :matches_niche, :detected_at, :metadata)
    `);
    const insertMany = this.db.transaction((items: TrendItem[]) => {
      for (const t of items) {
        stmt.run({
          id:            t.id,
          title:         t.title,
          source:        t.source,
          url:           t.url ?? null,
          score:         t.score,
          category:      t.category ?? null,
          matches_niche: t.matchesNiche ? 1 : 0,
          detected_at:   t.detectedAt,
          metadata:      JSON.stringify(t.metadata ?? {}),
        });
      }
    });
    insertMany(trends);
    logger.debug({ count: trends.length }, 'Trends stored');
  }

  /** Insert a single alert row and return its auto-assigned id. */
  storeAlert(
    trendId: string,
    reason: string,
    suggestedAction: string,
    urgency: TrendAlert['urgency'],
  ): number {
    const info = this.db.prepare(`
      INSERT INTO trend_alerts (trend_id, reason, suggested_action, urgency)
      VALUES (:trend_id, :reason, :suggested_action, :urgency)
    `).run({ trend_id: trendId, reason, suggested_action: suggestedAction, urgency });
    return info.lastInsertRowid as number;
  }

  /** Return trends from the last N hours, sorted by score desc. */
  getRecentTrends(hours = 24, limit = 100): TrendItem[] {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const rows = this.db.prepare<{ since: string; limit: number }, TrendRow>(`
      SELECT * FROM trend_radar
      WHERE detected_at >= :since
      ORDER BY score DESC, detected_at DESC
      LIMIT :limit
    `).all({ since, limit });
    return rows.map(rowToTrendItem);
  }

  /** Return the most recent alert rows joined with their trend data. */
  getAlerts(limit = 50): TrendAlert[] {
    const rows = this.db.prepare<{ limit: number }, AlertRow & TrendRow>(`
      SELECT ta.id, ta.trend_id, ta.reason, ta.suggested_action,
             ta.urgency, ta.acknowledged, ta.created_at,
             tr.title, tr.source, tr.url, tr.score,
             tr.category, tr.matches_niche, tr.detected_at, tr.metadata
      FROM trend_alerts ta
      JOIN trend_radar tr ON ta.trend_id = tr.id
      ORDER BY ta.created_at DESC
      LIMIT :limit
    `).all({ limit });

    return rows.map(r => ({
      id:              r.id,
      trend: {
        id:           r.trend_id,
        title:        r.title,
        source:       r.source as TrendItem['source'],
        url:          r.url ?? undefined,
        score:        r.score,
        category:     r.category ?? undefined,
        matchesNiche: r.matches_niche === 1,
        detectedAt:   r.detected_at,
        metadata:     safeParseJson(r.metadata),
      },
      reason:          r.reason,
      suggestedAction: r.suggested_action,
      urgency:         r.urgency as TrendAlert['urgency'],
      acknowledged:    r.acknowledged === 1,
      createdAt:       r.created_at,
    }));
  }

  /** Return aggregate statistics. */
  getStats(): Record<string, unknown> {
    const total = (this.db.prepare(
      'SELECT COUNT(*) AS n FROM trend_radar'
    ).get() as { n: number }).n;

    const bySource = this.db.prepare(
      'SELECT source, COUNT(*) AS n FROM trend_radar GROUP BY source'
    ).all() as Array<{ source: string; n: number }>;

    const nicheCount = (this.db.prepare(
      'SELECT COUNT(*) AS n FROM trend_radar WHERE matches_niche = 1'
    ).get() as { n: number }).n;

    const alertCount = (this.db.prepare(
      'SELECT COUNT(*) AS n FROM trend_alerts'
    ).get() as { n: number }).n;

    return {
      total,
      bySource: Object.fromEntries(bySource.map(r => [r.source, r.n])),
      nicheMatches: nicheCount,
      totalAlerts: alertCount,
    };
  }
}
