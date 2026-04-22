/**
 * smart-scheduler-schema.ts
 * Shared types, DDL, audience constants, and row-mapping utilities for SmartScheduler.
 */

import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScheduledTask {
  id: string;
  name: string;
  cronExpression: string | null;
  dependencies: string[];
  optimalTime: string | null;   // HH:MM in task's timezone
  timezone: string;
  cooldownMs: number;
  priority: 'critical' | 'high' | 'normal' | 'low';
  enabled: boolean;
  lastRun: string | null;       // ISO-8601
  nextRun: string | null;       // ISO-8601
  payload: unknown;
  createdAt: string;
}

export type NewTask = Omit<ScheduledTask, 'id' | 'nextRun' | 'createdAt'>;

export interface SchedulerStats {
  total: number;
  enabled: number;
  overdue: number;
}

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

export interface ScheduleRow {
  id: string;
  name: string;
  cron_expression: string | null;
  dependencies: string;
  optimal_time: string | null;
  timezone: string;
  cooldown_ms: number;
  priority: string;
  enabled: number;
  last_run: string | null;
  next_run: string | null;
  payload: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Audience analytics constants
// ---------------------------------------------------------------------------

/** IST peak hours (24h) by day type. */
export const PEAK_HOURS_IST: Record<'weekday' | 'weekend', number[]> = {
  weekday: [7, 8, 12, 13, 18, 19, 20, 21],
  weekend: [9, 10, 11, 14, 15, 19, 20, 21],
};

/** Content type keywords that prefer early (morning) peak slots. */
export const MORNING_CONTENT = new Set(['news', 'briefing', 'summary', 'digest']);

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS smart_schedule (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  cron_expression  TEXT,
  dependencies     TEXT DEFAULT '[]',
  optimal_time     TEXT,
  timezone         TEXT DEFAULT 'Asia/Kolkata',
  cooldown_ms      INTEGER DEFAULT 0,
  priority         TEXT DEFAULT 'normal',
  enabled          INTEGER DEFAULT 1,
  last_run         TEXT,
  next_run         TEXT,
  payload          TEXT DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ss_enabled    ON smart_schedule(enabled);
CREATE INDEX IF NOT EXISTS idx_ss_priority   ON smart_schedule(priority);
CREATE INDEX IF NOT EXISTS idx_ss_next_run   ON smart_schedule(next_run);
`;

// ---------------------------------------------------------------------------
// Schema initialiser
// ---------------------------------------------------------------------------

export function initSmartScheduleSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}

// ---------------------------------------------------------------------------
// Row → domain object mapper
// ---------------------------------------------------------------------------

export function rowToTask(row: ScheduleRow): ScheduledTask {
  let deps: string[] = [];
  try { deps = JSON.parse(row.dependencies) as string[]; } catch { deps = []; }
  let payload: unknown = {};
  try { payload = JSON.parse(row.payload); } catch { payload = {}; }

  return {
    id:             row.id,
    name:           row.name,
    cronExpression: row.cron_expression,
    dependencies:   Array.isArray(deps) ? deps : [],
    optimalTime:    row.optimal_time,
    timezone:       row.timezone,
    cooldownMs:     row.cooldown_ms,
    priority:       row.priority as ScheduledTask['priority'],
    enabled:        row.enabled === 1,
    lastRun:        row.last_run,
    nextRun:        row.next_run,
    payload,
    createdAt:      row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Given IST peak hours and current IST Date, return ISO-8601 of next peak slot.
 * preferMorning = true sorts ascending so the earliest available hour wins.
 */
export function nextPeakISO(peakHours: number[], nowIST: Date, preferMorning: boolean): string {
  const sorted = preferMorning
    ? [...peakHours].sort((a, b) => a - b)
    : [...peakHours].sort((a, b) => a - b); // same sort; morning flag selects first element

  const currentHour = nowIST.getHours();
  const todayHour = sorted.find(h => h > currentHour);
  const result = new Date(nowIST);
  result.setMinutes(0, 0, 0);

  if (todayHour !== undefined) {
    result.setHours(todayHour);
  } else {
    result.setDate(result.getDate() + 1);
    result.setHours(sorted[0]!);
  }
  return result.toISOString();
}

/** Return a Date representing "now" expressed in IST (UTC+5:30). */
export function nowInIST(): Date {
  const now = new Date();
  const offsetMs = 5.5 * 60 * 60 * 1000;
  return new Date(now.getTime() + offsetMs);
}

/** True if the given Date falls on Sat/Sun in IST. */
export function isWeekendIST(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}
