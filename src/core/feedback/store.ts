/**
 * Feedback store — persists the owner's task ratings in mind.db.
 *
 * Schema (created on first use):
 *   feedback(id, session_id, channel, task_summary, task_type, rating, notes, created_at)
 *
 * Also provides pattern analysis: what types of tasks get bad ratings most.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('feedback:store');

const DB_PATH = path.join(DATA_DIR, 'mind.db');

export type Rating = 'good' | 'bad' | 'skip';

export interface FeedbackEntry {
  id: string;
  session_id: string;
  channel: string;
  task_summary: string;
  task_type: string;
  rating: Rating;
  notes: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// DB init
// ---------------------------------------------------------------------------

function getDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL DEFAULT '',
      channel      TEXT NOT NULL DEFAULT 'telegram',
      task_summary TEXT NOT NULL DEFAULT '',
      task_type    TEXT NOT NULL DEFAULT 'general',
      rating       TEXT NOT NULL CHECK (rating IN ('good','bad','skip')),
      notes        TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback(rating);
    CREATE INDEX IF NOT EXISTS idx_feedback_type   ON feedback(task_type);
    CREATE INDEX IF NOT EXISTS idx_feedback_ts     ON feedback(created_at);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Detect task type from summary text
// ---------------------------------------------------------------------------

export function detectTaskType(summary: string): string {
  const s = summary.toLowerCase();
  if (/video|youtube|script|thumbnail|short|upload|remotion/.test(s))  return 'youtube';
  if (/code|fix|bug|build|deploy|tool|skill|typescript|npm/.test(s))   return 'coding';
  if (/search|research|find|trend|news|topic/.test(s))                 return 'research';
  if (/image|photo|generate|edit image/.test(s))                       return 'media';
  if (/health|status|check|diagnostic|monitor/.test(s))                return 'system';
  if (/schedule|cron|reminder|plan/.test(s))                           return 'scheduling';
  if (/email|telegram|notify|message|send/.test(s))                    return 'communication';
  return 'general';
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function saveFeedback(entry: Omit<FeedbackEntry, 'id' | 'created_at'>): string {
  const db = getDb();
  const id = randomUUID();
  try {
    db.prepare(`
      INSERT INTO feedback (id, session_id, channel, task_summary, task_type, rating, notes)
      VALUES (@id, @session_id, @channel, @task_summary, @task_type, @rating, @notes)
    `).run({ id, ...entry });
    log.info({ id, rating: entry.rating, type: entry.task_type }, 'Feedback saved');
  } finally {
    db.close();
  }
  return id;
}

export function addNoteToFeedback(feedbackId: string, notes: string): void {
  const db = getDb();
  try {
    db.prepare(`UPDATE feedback SET notes = @notes WHERE id = @id`).run({ notes, id: feedbackId });
    log.info({ feedbackId }, 'Feedback note added');
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface FeedbackStats {
  total: number;
  good: number;
  bad: number;
  skip: number;
  goodRate: number;
  byType: Record<string, { good: number; bad: number }>;
  recentBadSummaries: string[];
}

export function getFeedbackStats(limitDays = 30): FeedbackStats {
  const db = getDb();
  try {
    const since = new Date(Date.now() - limitDays * 86_400_000).toISOString();

    const rows = db.prepare(`
      SELECT rating, task_type, task_summary
      FROM feedback
      WHERE created_at >= ?
    `).all(since) as { rating: string; task_type: string; task_summary: string }[];

    const stats: FeedbackStats = {
      total: rows.length,
      good: 0, bad: 0, skip: 0,
      goodRate: 0,
      byType: {},
      recentBadSummaries: [],
    };

    for (const r of rows) {
      if (r.rating === 'good') stats.good++;
      else if (r.rating === 'bad') stats.bad++;
      else stats.skip++;

      if (!stats.byType[r.task_type]) stats.byType[r.task_type] = { good: 0, bad: 0 };
      if (r.rating === 'good') stats.byType[r.task_type]!.good++;
      if (r.rating === 'bad') {
        stats.byType[r.task_type]!.bad++;
        stats.recentBadSummaries.push(r.task_summary.slice(0, 80));
      }
    }

    const rated = stats.good + stats.bad;
    stats.goodRate = rated > 0 ? Math.round((stats.good / rated) * 100) : 100;
    stats.recentBadSummaries = stats.recentBadSummaries.slice(-5);

    return stats;
  } finally {
    db.close();
  }
}
