/**
 * @file thumbnail-ab-schema.ts
 * @description DDL and raw row type definitions for the Thumbnail A/B Testing module.
 *
 * Tables:
 *   ab_tests    — one row per test (one videoId, multiple variants)
 *   ab_variants — one row per variant thumbnail in a test
 *
 * Kept separate from thumbnail-ab.ts to keep each file under 300 lines.
 */

import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export interface ThumbnailVariant {
  id: string;
  videoId: string;
  variant: string;         // 'A', 'B', 'C' …
  imagePath: string;
  description: string;
  deployedAt?: string;
  measuredCtr?: number;
  impressions?: number;
  clicks?: number;
  isWinner: boolean;
}

export interface ABTest {
  id: string;
  videoId: string;
  variants: ThumbnailVariant[];
  status: 'setup' | 'running' | 'completed';
  winnerVariant?: string;
  startedAt?: string;
  completedAt?: string;
  measureAfterHours: number;
}

// ---------------------------------------------------------------------------
// Raw SQLite row types
// ---------------------------------------------------------------------------

export interface ABTestRow {
  id: string;
  video_id: string;
  status: string;
  winner_variant: string | null;
  started_at: string | null;
  completed_at: string | null;
  measure_after_hours: number;
  created_at: string;
}

export interface ABVariantRow {
  id: string;
  test_id: string;
  video_id: string;
  variant: string;
  image_path: string;
  description: string;
  deployed_at: string | null;
  measured_ctr: number | null;
  impressions: number | null;
  clicks: number | null;
  is_winner: number; // 0 | 1 in SQLite
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export const AB_SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ab_tests (
    id                  TEXT    PRIMARY KEY,
    video_id            TEXT    NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'setup',
    winner_variant      TEXT,
    started_at          TEXT,
    completed_at        TEXT,
    measure_after_hours INTEGER NOT NULL DEFAULT 48,
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS ab_variants (
    id           TEXT    PRIMARY KEY,
    test_id      TEXT    NOT NULL REFERENCES ab_tests(id) ON DELETE CASCADE,
    video_id     TEXT    NOT NULL,
    variant      TEXT    NOT NULL,
    image_path   TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    deployed_at  TEXT,
    measured_ctr REAL,
    impressions  INTEGER,
    clicks       INTEGER,
    is_winner    INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE INDEX IF NOT EXISTS idx_ab_tests_video_id  ON ab_tests(video_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_tests_status    ON ab_tests(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_variants_test   ON ab_variants(test_id)`,
];

// ---------------------------------------------------------------------------
// Schema initialiser
// ---------------------------------------------------------------------------

export function initABSchema(db: Database): void {
  for (const ddl of AB_SCHEMA_DDL) {
    db.exec(ddl);
  }
}

// ---------------------------------------------------------------------------
// Row converters
// ---------------------------------------------------------------------------

export function rowToVariant(row: ABVariantRow): ThumbnailVariant {
  return {
    id:          row.id,
    videoId:     row.video_id,
    variant:     row.variant,
    imagePath:   row.image_path,
    description: row.description,
    deployedAt:  row.deployed_at ?? undefined,
    measuredCtr: row.measured_ctr ?? undefined,
    impressions: row.impressions ?? undefined,
    clicks:      row.clicks ?? undefined,
    isWinner:    row.is_winner === 1,
  };
}

export function rowToTest(row: ABTestRow, variants: ThumbnailVariant[]): ABTest {
  return {
    id:                 row.id,
    videoId:            row.video_id,
    variants,
    status:             row.status as ABTest['status'],
    winnerVariant:      row.winner_variant ?? undefined,
    startedAt:          row.started_at ?? undefined,
    completedAt:        row.completed_at ?? undefined,
    measureAfterHours:  row.measure_after_hours,
  };
}
