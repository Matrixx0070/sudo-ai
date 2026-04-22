/**
 * @file event-daemon-schema.ts
 * @description DDL and raw row type definitions for the Event Daemon module.
 *
 * Tables:
 *   daemon_events — every detected or emitted event with priority and handler
 *
 * Kept separate from event-daemon.ts to keep each file under 300 lines.
 */

import type { Database } from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type EventPriority = 'low' | 'medium' | 'high' | 'critical';

export type EventType =
  | 'comment'
  | 'view_spike'
  | 'sub_milestone'
  | 'competitor'
  | 'system'
  | 'quota'
  | 'custom';

export interface DaemonEvent {
  id: string;
  type: string;        // EventType or any custom string
  source: string;
  data: unknown;
  priority: EventPriority;
  handled: boolean;
  handler?: string;    // description of action taken
  detectedAt: string;
}

export interface EventStats {
  totalEvents: number;
  handled: number;
  unhandled: number;
  byType: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Raw SQLite row type
// ---------------------------------------------------------------------------

export interface DaemonEventRow {
  id: string;
  type: string;
  source: string;
  data: string;       // JSON-serialised
  priority: string;
  handled: number;    // 0 | 1
  handler: string | null;
  detected_at: string;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export const DAEMON_SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS daemon_events (
    id          TEXT    PRIMARY KEY,
    type        TEXT    NOT NULL,
    source      TEXT    NOT NULL DEFAULT '',
    data        TEXT    NOT NULL DEFAULT '{}',
    priority    TEXT    NOT NULL DEFAULT 'medium',
    handled     INTEGER NOT NULL DEFAULT 0,
    handler     TEXT,
    detected_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_daemon_events_type     ON daemon_events(type)`,
  `CREATE INDEX IF NOT EXISTS idx_daemon_events_handled  ON daemon_events(handled)`,
  `CREATE INDEX IF NOT EXISTS idx_daemon_events_priority ON daemon_events(priority)`,
  `CREATE INDEX IF NOT EXISTS idx_daemon_events_detected ON daemon_events(detected_at DESC)`,
];

// ---------------------------------------------------------------------------
// Schema initialiser
// ---------------------------------------------------------------------------

export function initDaemonSchema(db: Database): void {
  for (const ddl of DAEMON_SCHEMA_DDL) {
    db.exec(ddl);
  }
}

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

export function rowToEvent(row: DaemonEventRow): DaemonEvent {
  let data: unknown = {};
  try { data = JSON.parse(row.data); } catch { /* leave empty object */ }
  return {
    id:          row.id,
    type:        row.type,
    source:      row.source,
    data,
    priority:    row.priority as EventPriority,
    handled:     row.handled === 1,
    handler:     row.handler ?? undefined,
    detectedAt:  row.detected_at,
  };
}
