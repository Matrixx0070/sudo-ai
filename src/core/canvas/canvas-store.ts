/**
 * @file canvas-store.ts
 * @description Persists the latest canvas payload per session (Spec 2) so a
 * reconnecting client can re-hydrate the panel and for audit. Plain SQLite,
 * modeled on loop-signature-store.ts. One row per session (upsert).
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { CanvasPayload } from './schema.js';

const log = createLogger('canvas:store');

export class CanvasStateStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_state (
        session_id  TEXT PRIMARY KEY,
        payload     TEXT NOT NULL,
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
  }

  /** Upsert the latest payload for a session. Fail-open (never throws to caller). */
  save(sessionId: string, payload: CanvasPayload): void {
    if (!sessionId) return;
    try {
      this.db.prepare(`
        INSERT INTO canvas_state (session_id, payload, updated_at)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(session_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
      `).run(sessionId, JSON.stringify(payload));
    } catch (err) {
      log.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, 'canvas_state save failed');
    }
  }

  /** Latest payload for a session, or null. */
  get(sessionId: string): CanvasPayload | null {
    try {
      const row = this.db.prepare('SELECT payload FROM canvas_state WHERE session_id = ?').get(sessionId) as { payload: string } | undefined;
      return row ? (JSON.parse(row.payload) as CanvasPayload) : null;
    } catch { return null; }
  }

  /** Clear a session's canvas (e.g. on /reset). */
  clear(sessionId: string): void {
    try { this.db.prepare('DELETE FROM canvas_state WHERE session_id = ?').run(sessionId); } catch { /* fail-open */ }
  }

  /**
   * Most-recently-updated canvases across sessions, newest first — powers the
   * read-only /admin monitoring panel. Rows with unparseable payloads are
   * skipped. Fail-open: returns [] on any error.
   */
  list(limit = 20): Array<{ sessionId: string; updatedAt: string; payload: CanvasPayload }> {
    try {
      const cap = Math.max(1, Math.min(100, Math.floor(limit)));
      const rows = this.db.prepare(
        'SELECT session_id, payload, updated_at FROM canvas_state ORDER BY updated_at DESC LIMIT ?',
      ).all(cap) as Array<{ session_id: string; payload: string; updated_at: string }>;
      const out: Array<{ sessionId: string; updatedAt: string; payload: CanvasPayload }> = [];
      for (const r of rows) {
        try { out.push({ sessionId: r.session_id, updatedAt: r.updated_at, payload: JSON.parse(r.payload) as CanvasPayload }); }
        catch { /* skip corrupt row */ }
      }
      return out;
    } catch { return []; }
  }
}
