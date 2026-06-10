/**
 * @file inspection-queue.ts
 * @description Inspection queue factory for flagged content review.
 *
 * Stores hash + 500-char excerpt only — full payloads are NEVER persisted.
 * The table DDL lives in src/core/memory/schema.ts (inspection_queue).
 * This factory only operates on the table; it does NOT create it.
 *
 * Usage:
 *   const queue = createInspectionQueue(db);
 *   const id = queue.enqueue({ source, category, severity, fullPayload, patternMatches });
 *   const entries = queue.query({ status: 'pending' });
 *   queue.updateStatus(id, 'cleared', 'admin');
 */

import type { Database } from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('security:inspection-queue');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InspectionStatus = 'pending' | 'reviewed' | 'cleared' | 'blocked';
export type InspectionCategory = 'inbound' | 'generated' | 'memory';

export interface InspectionQueueEntry {
  id: string;
  created_at: string;
  source: string;
  category: InspectionCategory;
  severity: string;
  payload_excerpt: string;
  payload_hash: string;
  pattern_matches: string[];
  status: InspectionStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface EnqueueOptions {
  /** Human-readable source label (tool name, operation, etc.) */
  source: string;
  /** Category of flagged content */
  category: InspectionCategory;
  /** Severity level — 'high' | 'medium' | 'low' or any string label */
  severity: string;
  /** Full payload — only the first 500 chars will be stored */
  fullPayload: string;
  /** Pattern labels that triggered the flag */
  patternMatches: string[];
}

export interface QueryFilter {
  status?: InspectionStatus;
  limit?: number;
}

export interface InspectionQueueInstance {
  enqueue(opts: EnqueueOptions): string;
  query(filter?: QueryFilter): InspectionQueueEntry[];
  updateStatus(id: string, status: InspectionStatus, reviewedBy?: string): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function mapRow(row: Record<string, unknown>): InspectionQueueEntry {
  let patternMatches: string[] = [];
  try {
    const parsed = JSON.parse(row['pattern_matches'] as string);
    patternMatches = Array.isArray(parsed) ? parsed : [];
  } catch {
    patternMatches = [];
  }

  return {
    id: row['id'] as string,
    created_at: row['created_at'] as string,
    source: row['source'] as string,
    category: row['category'] as InspectionCategory,
    severity: row['severity'] as string,
    payload_excerpt: row['payload_excerpt'] as string,
    payload_hash: row['payload_hash'] as string,
    pattern_matches: patternMatches,
    status: row['status'] as InspectionStatus,
    reviewed_by: (row['reviewed_by'] as string | null) ?? null,
    reviewed_at: (row['reviewed_at'] as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an InspectionQueueInstance bound to an open better-sqlite3 database.
 *
 * Expects the `inspection_queue` table to already exist (created by
 * initializeSchema from src/core/memory/schema.ts).
 *
 * @param db - An open better-sqlite3 Database instance.
 */
export function createInspectionQueue(db: Database): InspectionQueueInstance {
  // Prepare statements once at construction time for performance.
  const stmtInsert = db.prepare(`
    INSERT INTO inspection_queue
      (id, source, category, severity, payload_excerpt, payload_hash, pattern_matches)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtSelectAll = db.prepare(`
    SELECT * FROM inspection_queue
    ORDER BY created_at DESC
    LIMIT ?
  `);

  const stmtSelectByStatus = db.prepare(`
    SELECT * FROM inspection_queue
    WHERE status = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);

  const stmtUpdate = db.prepare(`
    UPDATE inspection_queue
    SET status = ?, reviewed_by = ?, reviewed_at = ?
    WHERE id = ?
  `);

  return {
    /**
     * Enqueue a flagged content item.
     * Only stores first 500 chars of payload + SHA-256 hash.
     * @returns Generated UUID for the new row.
     */
    enqueue(opts: EnqueueOptions): string {
      const id = randomUUID();
      const payload_excerpt = opts.fullPayload.slice(0, 500);
      const payload_hash = sha256Hex(opts.fullPayload);
      const pattern_matches = JSON.stringify(opts.patternMatches);

      stmtInsert.run(
        id,
        opts.source,
        opts.category,
        opts.severity,
        payload_excerpt,
        payload_hash,
        pattern_matches,
      );

      log.debug(
        { id, source: opts.source, category: opts.category, severity: opts.severity },
        'Inspection queue entry created',
      );

      return id;
    },

    /**
     * Query inspection queue entries.
     * @param filter - Optional status filter and result limit (default 100).
     */
    query(filter?: QueryFilter): InspectionQueueEntry[] {
      const limit = filter?.limit ?? 100;

      let rows: Record<string, unknown>[];
      if (filter?.status !== undefined) {
        rows = stmtSelectByStatus.all(filter.status, limit) as Record<string, unknown>[];
      } else {
        rows = stmtSelectAll.all(limit) as Record<string, unknown>[];
      }

      return rows.map(mapRow);
    },

    /**
     * Update the review status of an inspection queue entry.
     * @param id          - UUID of the entry to update.
     * @param status      - New status value.
     * @param reviewedBy  - Optional reviewer identifier.
     */
    updateStatus(id: string, status: InspectionStatus, reviewedBy?: string): void {
      const reviewedAt = new Date().toISOString();
      stmtUpdate.run(status, reviewedBy ?? null, reviewedAt, id);

      log.debug({ id, status, reviewedBy }, 'Inspection queue entry status updated');
    },
  };
}
