/**
 * @file markers.ts
 * @description SomaticMarkerStore — CRUD and activation logic for somatic
 * markers in the SUDO-AI v4 consciousness layer.
 *
 * Markers are persisted in the `somatic_markers` SQLite table managed by
 * ConsciousnessDB. All operations are synchronous (better-sqlite3).
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import { genId } from '../../shared/utils.js';
import type { EmotionTag } from '../types.js';
import type { SomaticMarker } from './types.js';

const log = createLogger('consciousness:emotional-memory');

/** Days after which a NEVER-reinforced marker (times_triggered=0) is pruned as noise. 0 disables. Default 30. */
function somaticRetentionDays(): number {
  const raw = Number(process.env['SUDO_SOMATIC_RETENTION_DAYS']);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
}

/** Hard cap on total somatic markers — least-reinforced/oldest beyond this are pruned. 0 disables. Default 5000. */
function somaticMaxRows(): number {
  const raw = Number(process.env['SUDO_SOMATIC_MAX_ROWS']);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
}

// ---------------------------------------------------------------------------
// Row shape from the somatic_markers table
// ---------------------------------------------------------------------------

interface SomaticMarkerRow {
  id: string;
  trigger_pattern: string;
  emotion: string;
  intensity: number;
  associated_episode_id: string | null;
  times_triggered: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

function rowToMarker(row: SomaticMarkerRow): SomaticMarker {
  return {
    id:                  row.id,
    triggerPattern:      row.trigger_pattern,
    emotion:             row.emotion as EmotionTag,
    intensity:           row.intensity,
    associatedEpisodeId: row.associated_episode_id,
    timesTriggered:      row.times_triggered,
    createdAt:           row.created_at,
  };
}

// ---------------------------------------------------------------------------
// SomaticMarkerStore
// ---------------------------------------------------------------------------

/**
 * Manages creation, retrieval, and activation of somatic markers.
 * A somatic marker is a learned association between a trigger text pattern
 * and an emotional response intensity.
 */
export class SomaticMarkerStore {
  private readonly cdb: ConsciousnessDB;

  constructor(cdb: ConsciousnessDB) {
    if (!cdb) {
      throw new ConsciousnessError(
        'SomaticMarkerStore requires a ConsciousnessDB instance',
        'consciousness_emotional_invalid_db',
      );
    }
    this.cdb = cdb;
    log.debug('SomaticMarkerStore initialised');
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Create and persist a new somatic marker.
   *
   * @param trigger     - Text pattern that activates this marker.
   * @param emotion     - The emotion tag associated with the trigger.
   * @param intensity   - Response intensity 0..1.
   * @param episodeId   - Optional episodic memory back-reference.
   * @returns The newly created SomaticMarker.
   * @throws ConsciousnessError on validation failure or DB error.
   */
  createMarker(
    trigger: string,
    emotion: EmotionTag,
    intensity: number,
    episodeId?: string,
  ): SomaticMarker {
    if (!trigger || typeof trigger !== 'string' || trigger.trim().length === 0) {
      throw new ConsciousnessError(
        'createMarker: trigger must be a non-empty string',
        'consciousness_emotional_invalid_trigger',
        { trigger },
      );
    }
    if (typeof intensity !== 'number' || intensity < 0 || intensity > 1) {
      throw new ConsciousnessError(
        `createMarker: intensity must be 0..1, got ${intensity}`,
        'consciousness_emotional_invalid_intensity',
        { intensity },
      );
    }

    const id = genId();
    const now = new Date().toISOString();

    try {
      const db = this.cdb.getDb();
      db.prepare(
        `INSERT INTO somatic_markers
           (id, trigger_pattern, emotion, intensity, associated_episode_id, times_triggered, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      ).run(id, trigger.trim(), emotion, intensity, episodeId ?? null, now);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(
        `createMarker: DB insert failed — ${msg}`,
        'consciousness_emotional_marker_insert_failed',
        { trigger, emotion, intensity, cause: msg },
      );
    }

    const marker: SomaticMarker = {
      id,
      triggerPattern:      trigger.trim(),
      emotion,
      intensity,
      associatedEpisodeId: episodeId ?? null,
      timesTriggered:      0,
      createdAt:           now,
    };

    log.debug({ id, trigger: marker.triggerPattern, emotion, intensity }, 'Somatic marker created');
    return marker;
  }

  // -------------------------------------------------------------------------
  // Retrieval / Activation
  // -------------------------------------------------------------------------

  /**
   * Find all markers whose trigger_pattern matches any of the given concepts,
   * increment each matched marker's times_triggered counter, and return the
   * matched markers sorted by intensity descending.
   *
   * @param concepts - Array of concept strings to match against trigger patterns.
   * @returns Matched SomaticMarker array, ordered by intensity DESC.
   */
  getSomaticResponse(concepts: string[]): SomaticMarker[] {
    if (!Array.isArray(concepts)) {
      log.warn({ concepts }, 'getSomaticResponse: concepts must be an array');
      return [];
    }
    if (concepts.length === 0) return [];

    const db = this.cdb.getDb();
    const matched = new Map<string, SomaticMarker>();

    for (const concept of concepts) {
      if (typeof concept !== 'string' || concept.trim().length === 0) continue;

      try {
        const rows = db
          .prepare<[string], SomaticMarkerRow>(
            `SELECT id, trigger_pattern, emotion, intensity,
                    associated_episode_id, times_triggered, created_at
               FROM somatic_markers
              WHERE trigger_pattern LIKE ?`,
          )
          .all(`%${concept.trim()}%`);

        for (const row of rows) {
          if (!matched.has(row.id)) {
            matched.set(row.id, rowToMarker(row));
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ concept, error: msg }, 'getSomaticResponse: query error');
      }
    }

    if (matched.size === 0) return [];

    // Increment times_triggered for every matched marker in a single transaction.
    const ids = Array.from(matched.keys());
    try {
      const increment = db.transaction(() => {
        const stmt = db.prepare<[string]>(
          `UPDATE somatic_markers
              SET times_triggered = times_triggered + 1
            WHERE id = ?`,
        );
        for (const id of ids) {
          stmt.run(id);
          const marker = matched.get(id);
          if (marker) {
            matched.set(id, { ...marker, timesTriggered: marker.timesTriggered + 1 });
          }
        }
      });
      increment();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ ids, error: msg }, 'getSomaticResponse: failed to increment times_triggered');
    }

    const results = Array.from(matched.values()).sort((a, b) => b.intensity - a.intensity);
    log.debug({ conceptCount: concepts.length, matched: results.length }, 'Somatic response computed');
    return results;
  }

  /**
   * Retrieve all markers associated with a specific emotion.
   *
   * @param emotion - The EmotionTag to filter by.
   * @returns Array of SomaticMarker objects.
   */
  getMarkersByEmotion(emotion: EmotionTag): SomaticMarker[] {
    try {
      const db = this.cdb.getDb();
      const rows = db
        .prepare<[string], SomaticMarkerRow>(
          `SELECT id, trigger_pattern, emotion, intensity,
                  associated_episode_id, times_triggered, created_at
             FROM somatic_markers
            WHERE emotion = ?
            ORDER BY intensity DESC`,
        )
        .all(emotion);

      log.debug({ emotion, count: rows.length }, 'Markers fetched by emotion');
      return rows.map(rowToMarker);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(
        `getMarkersByEmotion query failed: ${msg}`,
        'consciousness_emotional_markers_query_failed',
        { emotion, cause: msg },
      );
    }
  }

  /**
   * Retrieve every somatic marker in the store.
   *
   * @returns Array of all SomaticMarker objects, ordered by intensity DESC.
   */
  getAllMarkers(): SomaticMarker[] {
    try {
      const db = this.cdb.getDb();
      const rows = db
        .prepare<[], SomaticMarkerRow>(
          `SELECT id, trigger_pattern, emotion, intensity,
                  associated_episode_id, times_triggered, created_at
             FROM somatic_markers
            ORDER BY intensity DESC`,
        )
        .all();

      log.debug({ count: rows.length }, 'All somatic markers fetched');
      return rows.map(rowToMarker);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(
        `getAllMarkers query failed: ${msg}`,
        'consciousness_emotional_markers_all_failed',
        { cause: msg },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  /**
   * Keep somatic_markers bounded. This is a LEARNING store, so retention is
   * VALUE-AWARE rather than pure age:
   *   (1) drop never-reinforced markers (times_triggered = 0) older than
   *       `retentionDays` — one-off associations that never recurred (noise);
   *   (2) if still over `maxRows`, drop the least-valuable (lowest
   *       times_triggered, then oldest), keeping the most-reinforced.
   * Both default to SUDO_SOMATIC_RETENTION_DAYS / SUDO_SOMATIC_MAX_ROWS; pass 0
   * to disable a bound. Returns rows deleted. Fail-open — never throws.
   */
  prune(opts: { retentionDays?: number; maxRows?: number } = {}): number {
    const retentionDays = opts.retentionDays ?? somaticRetentionDays();
    const maxRows = opts.maxRows ?? somaticMaxRows();
    let deleted = 0;
    try {
      const db = this.cdb.getDb();
      // (1) Never-reinforced + stale. created_at is ISO, so compare against an
      //     ISO cutoff (strftime ...Z), not datetime() which is space-format.
      if (retentionDays > 0) {
        // retentionDays is Number-coerced + isFinite/>=0-guarded above, so the modifier is safe to interpolate.
        deleted += db
          .prepare("DELETE FROM somatic_markers WHERE times_triggered = 0 AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)")
          .run(`-${retentionDays} days`).changes;
      }
      // (2) Hard cap: keep the most-reinforced (then most-recent) maxRows, drop the rest.
      // `id IS NOT NULL` in the subquery avoids SQLite's NOT IN + NULL footgun (a single
      // NULL would make NOT IN match nothing); id is NOT NULL PK so this is belt-and-suspenders.
      if (maxRows > 0) {
        const total = (db.prepare('SELECT COUNT(*) AS c FROM somatic_markers').get() as { c: number }).c;
        if (total > maxRows) {
          deleted += db
            .prepare('DELETE FROM somatic_markers WHERE id NOT IN (SELECT id FROM somatic_markers WHERE id IS NOT NULL ORDER BY times_triggered DESC, created_at DESC LIMIT ?)')
            .run(maxRows).changes;
        }
      }
      if (deleted > 0) log.info({ deleted, retentionDays, maxRows }, 'Somatic markers pruned');
    } catch (err: unknown) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Somatic marker prune failed — continuing');
    }
    return deleted;
  }
}
