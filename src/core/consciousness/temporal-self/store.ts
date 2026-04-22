/**
 * @file store.ts
 * @description DB access layer for the temporal-self subsystem.
 * Tables: self_snapshots, aspirations (see consciousness-db.ts).
 * Synchronous better-sqlite3 API throughout — no async/await.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { SelfSnapshot, Aspiration } from './types.js';

const log = createLogger('temporal-self:store');

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface SnapshotRow {
  id: string;
  capabilities: string;
  personality: string;
  dominant_emotion: string;
  active_goals: string;
  snapshot_at: string;
}

interface AspirationRow {
  id: string;
  description: string;
  current_level: string;
  target_level: string;
  domain: string;
  estimated_timeframe: string;
  status: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Row converters
// ---------------------------------------------------------------------------

function rowToSnapshot(row: SnapshotRow): SelfSnapshot {
  return {
    id: row.id,
    capabilities: JSON.parse(row.capabilities) as Record<string, string>,
    personality: JSON.parse(row.personality) as Record<string, number>,
    dominantEmotion: row.dominant_emotion as SelfSnapshot['dominantEmotion'],
    activeGoals: JSON.parse(row.active_goals) as string[],
    snapshotAt: row.snapshot_at,
  };
}

function rowToAspiration(row: AspirationRow): Aspiration {
  return {
    id: row.id,
    description: row.description,
    currentLevel: row.current_level,
    targetLevel: row.target_level,
    domain: row.domain,
    estimatedTimeframe: row.estimated_timeframe,
    status: row.status as Aspiration['status'],
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Snapshot CRUD
// ---------------------------------------------------------------------------

/**
 * Persist a SelfSnapshot.
 * @throws ConsciousnessError on invalid input or DB write failure.
 */
export function saveSnapshot(db: Database.Database, snapshot: SelfSnapshot): void {
  if (!snapshot.id || typeof snapshot.id !== 'string') {
    throw new ConsciousnessError(
      'saveSnapshot: snapshot.id must be a non-empty string',
      'consciousness_temporal_self_invalid_snapshot',
      { id: snapshot.id },
    );
  }
  try {
    db.prepare(
      `INSERT OR REPLACE INTO self_snapshots
         (id, capabilities, personality, dominant_emotion, active_goals, snapshot_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      snapshot.id,
      JSON.stringify(snapshot.capabilities),
      JSON.stringify(snapshot.personality),
      snapshot.dominantEmotion,
      JSON.stringify(snapshot.activeGoals),
      snapshot.snapshotAt,
    );
    log.debug({ id: snapshot.id, snapshotAt: snapshot.snapshotAt }, 'Snapshot saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `saveSnapshot DB error: ${msg}`,
      'consciousness_temporal_self_db_write',
      { id: snapshot.id, cause: msg },
    );
  }
}

/**
 * Return the most recent `count` snapshots in descending chronological order.
 * @throws ConsciousnessError on DB read failure.
 */
export function getTimeline(db: Database.Database, count: number): SelfSnapshot[] {
  if (typeof count !== 'number' || count < 1 || !Number.isFinite(count)) {
    throw new ConsciousnessError(
      'getTimeline: count must be a positive finite number',
      'consciousness_temporal_self_invalid_count',
      { count },
    );
  }
  try {
    const rows = db
      .prepare('SELECT * FROM self_snapshots ORDER BY snapshot_at DESC LIMIT ?')
      .all(count) as SnapshotRow[];
    log.debug({ requested: count, returned: rows.length }, 'Timeline loaded');
    return rows.map(rowToSnapshot);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getTimeline DB error: ${msg}`,
      'consciousness_temporal_self_db_read',
      { cause: msg },
    );
  }
}

// ---------------------------------------------------------------------------
// Aspiration CRUD
// ---------------------------------------------------------------------------

/**
 * Persist a new aspiration.
 * @throws ConsciousnessError on invalid input or DB write failure.
 */
export function saveAspiration(db: Database.Database, asp: Aspiration): void {
  if (!asp.id || typeof asp.id !== 'string') {
    throw new ConsciousnessError(
      'saveAspiration: aspiration.id must be a non-empty string',
      'consciousness_temporal_self_invalid_aspiration',
      { id: asp.id },
    );
  }
  if (!asp.domain || typeof asp.domain !== 'string') {
    throw new ConsciousnessError(
      'saveAspiration: aspiration.domain must be a non-empty string',
      'consciousness_temporal_self_invalid_aspiration',
      { domain: asp.domain },
    );
  }
  try {
    db.prepare(
      `INSERT OR REPLACE INTO aspirations
         (id, description, current_level, target_level, domain,
          estimated_timeframe, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      asp.id,
      asp.description,
      asp.currentLevel,
      asp.targetLevel,
      asp.domain,
      asp.estimatedTimeframe,
      asp.status,
      asp.createdAt,
    );
    log.debug({ id: asp.id, domain: asp.domain }, 'Aspiration saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `saveAspiration DB error: ${msg}`,
      'consciousness_temporal_self_db_write',
      { id: asp.id, cause: msg },
    );
  }
}

/**
 * Return aspirations, optionally filtered by status.
 * @throws ConsciousnessError on DB read failure.
 */
export function getAspirations(db: Database.Database, status?: string): Aspiration[] {
  try {
    let rows: AspirationRow[];
    if (status !== undefined) {
      if (typeof status !== 'string' || status.length === 0) {
        throw new ConsciousnessError(
          'getAspirations: status must be a non-empty string when provided',
          'consciousness_temporal_self_invalid_status',
          { status },
        );
      }
      rows = db
        .prepare('SELECT * FROM aspirations WHERE status = ? ORDER BY created_at DESC')
        .all(status) as AspirationRow[];
    } else {
      rows = db
        .prepare('SELECT * FROM aspirations ORDER BY created_at DESC')
        .all() as AspirationRow[];
    }
    log.debug({ status: status ?? 'all', returned: rows.length }, 'Aspirations loaded');
    return rows.map(rowToAspiration);
  } catch (err: unknown) {
    if (err instanceof ConsciousnessError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getAspirations DB error: ${msg}`,
      'consciousness_temporal_self_db_read',
      { cause: msg },
    );
  }
}

/**
 * Update the status of an existing aspiration by ID.
 * @throws ConsciousnessError on invalid input or DB write failure.
 */
export function updateAspirationStatus(
  db: Database.Database,
  id: string,
  status: string,
): void {
  if (!id || typeof id !== 'string') {
    throw new ConsciousnessError(
      'updateAspirationStatus: id must be a non-empty string',
      'consciousness_temporal_self_invalid_aspiration',
      { id },
    );
  }
  const valid = ['active', 'achieved', 'abandoned'];
  if (!valid.includes(status)) {
    throw new ConsciousnessError(
      `updateAspirationStatus: status must be one of ${valid.join(', ')}`,
      'consciousness_temporal_self_invalid_status',
      { id, status },
    );
  }
  try {
    const result = db
      .prepare('UPDATE aspirations SET status = ? WHERE id = ?')
      .run(status, id);
    if (result.changes === 0) {
      log.warn({ id, status }, 'updateAspirationStatus: no row matched id');
    } else {
      log.debug({ id, status }, 'Aspiration status updated');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `updateAspirationStatus DB error: ${msg}`,
      'consciousness_temporal_self_db_write',
      { id, status, cause: msg },
    );
  }
}
