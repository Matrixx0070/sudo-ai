/**
 * @file store.ts
 * @description SQLite persistence helpers for the CognitiveStream.
 *
 * Uses prepared statements cached inside factory closures for performance.
 * All functions are synchronous (better-sqlite3 API).
 */

import type { Database as BetterSqlite3DB } from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { ThoughtTier } from '../types.js';
import type { StreamThought } from './types.js';

const log = createLogger('consciousness:cognitive-stream:store');

// ---------------------------------------------------------------------------
// Row shape returned by SQLite
// ---------------------------------------------------------------------------

interface ThoughtRow {
  id: string;
  content: string;
  tier: ThoughtTier;
  source: string;
  activated_concepts: string;
  emotional_valence: string;
  body_state: string;
  parent_thought_id: string | null;
  depth: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function rowToThought(row: ThoughtRow): StreamThought {
  return {
    id: row.id,
    content: row.content,
    tier: row.tier,
    timestamp: row.created_at,
    source: row.source,
    activatedConcepts: JSON.parse(row.activated_concepts) as string[],
    emotionalValence: JSON.parse(row.emotional_valence) as StreamThought['emotionalValence'],
    bodyStateSnapshot: JSON.parse(row.body_state) as StreamThought['bodyStateSnapshot'],
    parentThoughtId: row.parent_thought_id,
    depth: row.depth,
  };
}

// ---------------------------------------------------------------------------
// Cached statement factories (closure pattern — statements built once per db)
// ---------------------------------------------------------------------------

let _db: BetterSqlite3DB | null = null;
let _insertStmt: ReturnType<BetterSqlite3DB['prepare']> | null = null;
let _recentStmt: ReturnType<BetterSqlite3DB['prepare']> | null = null;
let _byTierStmt: ReturnType<BetterSqlite3DB['prepare']> | null = null;
let _pruneStmt: ReturnType<BetterSqlite3DB['prepare']> | null = null;

function getStatements(db: BetterSqlite3DB) {
  if (_db !== db) {
    // New db instance — rebuild all statements.
    _db = db;

    _insertStmt = db.prepare(`
      INSERT INTO thoughts
        (id, content, tier, source, activated_concepts, emotional_valence,
         body_state, parent_thought_id, depth, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    _recentStmt = db.prepare(`
      SELECT id, content, tier, source, activated_concepts, emotional_valence,
             body_state, parent_thought_id, depth, created_at
        FROM thoughts
       ORDER BY created_at DESC
       LIMIT ?
    `);

    _byTierStmt = db.prepare(`
      SELECT id, content, tier, source, activated_concepts, emotional_valence,
             body_state, parent_thought_id, depth, created_at
        FROM thoughts
       WHERE tier = ?
       ORDER BY created_at DESC
       LIMIT ?
    `);

    _pruneStmt = db.prepare(`
      DELETE FROM thoughts
       WHERE id NOT IN (
         SELECT id FROM thoughts ORDER BY created_at DESC LIMIT ?
       )
    `);
  }

  return {
    insert: _insertStmt!,
    recent: _recentStmt!,
    byTier: _byTierStmt!,
    prune: _pruneStmt!,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a StreamThought to the `thoughts` table.
 *
 * @throws ConsciousnessError on DB failure.
 */
export function saveThought(cdb: ConsciousnessDB, thought: StreamThought): void {
  if (!thought?.id || typeof thought.content !== 'string') {
    throw new ConsciousnessError(
      'saveThought: thought must have id and content',
      'consciousness_cognitive_stream_invalid_thought',
      { thoughtId: thought?.id },
    );
  }
  if (!['micro', 'medium', 'deep'].includes(thought.tier)) {
    throw new ConsciousnessError(
      `saveThought: invalid tier "${thought.tier}"`,
      'consciousness_cognitive_stream_invalid_tier',
      { tier: thought.tier },
    );
  }

  // Map free-form source to the DB CHECK constraint values.
  const dbSource = (['stream', 'interrupt', 'reflection', 'dream'] as const).includes(
    thought.source as 'stream' | 'interrupt' | 'reflection' | 'dream',
  )
    ? thought.source
    : 'stream';

  try {
    const db = cdb.getDb();
    const { insert } = getStatements(db);
    insert.run([
      thought.id,
      thought.content,
      thought.tier,
      dbSource,
      JSON.stringify(thought.activatedConcepts),
      JSON.stringify(thought.emotionalValence),
      JSON.stringify(thought.bodyStateSnapshot),
      thought.parentThoughtId,
      thought.depth,
      thought.timestamp,
    ]);
    log.debug({ id: thought.id, tier: thought.tier }, 'Thought saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `saveThought failed: ${msg}`,
      'consciousness_cognitive_stream_save_failed',
      { thoughtId: thought.id, cause: msg },
    );
  }
}

/**
 * Retrieve the most recent thoughts ordered newest-first.
 *
 * @param cdb   - Open ConsciousnessDB instance.
 * @param count - Number of thoughts to return.
 * @returns Array of Thought objects (may be empty).
 */
export function getRecentThoughts(cdb: ConsciousnessDB, count: number): StreamThought[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      `getRecentThoughts: count must be a positive integer, got ${count}`,
      'consciousness_cognitive_stream_invalid_count',
      { count },
    );
  }

  try {
    const db = cdb.getDb();
    const { recent } = getStatements(db);
    const rows = recent.all(count) as ThoughtRow[];
    return rows.map(rowToThought) as StreamThought[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getRecentThoughts failed: ${msg}`,
      'consciousness_cognitive_stream_read_failed',
      { count, cause: msg },
    );
  }
}

/**
 * Retrieve the most recent thoughts of a specific tier.
 *
 * @param cdb   - Open ConsciousnessDB instance.
 * @param tier  - ThoughtTier to filter by.
 * @param count - Number of thoughts to return.
 * @returns Array of Thought objects (may be empty).
 */
export function getThoughtsByTier(
  cdb: ConsciousnessDB,
  tier: ThoughtTier,
  count: number,
): StreamThought[] {
  if (!['micro', 'medium', 'deep'].includes(tier)) {
    throw new ConsciousnessError(
      `getThoughtsByTier: invalid tier "${tier}"`,
      'consciousness_cognitive_stream_invalid_tier',
      { tier },
    );
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      `getThoughtsByTier: count must be a positive integer, got ${count}`,
      'consciousness_cognitive_stream_invalid_count',
      { count },
    );
  }

  try {
    const db = cdb.getDb();
    const { byTier } = getStatements(db);
    const rows = byTier.all([tier, count]) as ThoughtRow[];
    return rows.map(rowToThought) as StreamThought[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getThoughtsByTier failed: ${msg}`,
      'consciousness_cognitive_stream_read_failed',
      { tier, count, cause: msg },
    );
  }
}

/**
 * Delete oldest thoughts, keeping at most `keepCount` entries.
 *
 * @param cdb       - Open ConsciousnessDB instance.
 * @param keepCount - How many most-recent thoughts to retain (default: 10000).
 * @returns Number of rows deleted.
 */
export function pruneOldThoughts(cdb: ConsciousnessDB, keepCount: number = 10_000): number {
  if (!Number.isInteger(keepCount) || keepCount < 1) {
    throw new ConsciousnessError(
      `pruneOldThoughts: keepCount must be a positive integer, got ${keepCount}`,
      'consciousness_cognitive_stream_invalid_count',
      { keepCount },
    );
  }

  try {
    const db = cdb.getDb();
    const { prune } = getStatements(db);
    const result = prune.run(keepCount);
    const deleted = result.changes;
    if (deleted > 0) {
      log.info({ deleted, keepCount }, 'Old thoughts pruned');
    }
    return deleted;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `pruneOldThoughts failed: ${msg}`,
      'consciousness_cognitive_stream_prune_failed',
      { keepCount, cause: msg },
    );
  }
}
