/**
 * @file store.ts
 * @description SQLite persistence layer for the drive-system's drive_log table.
 *
 * All functions are synchronous (better-sqlite3 API).
 * Every mutation is logged and wrapped in a ConsciousnessError on failure.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { Drive } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('drive-system:store');

// ---------------------------------------------------------------------------
// Persisted row shape
// ---------------------------------------------------------------------------

interface DriveLogRow {
  drives: string;
  dominant: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Public store functions
// ---------------------------------------------------------------------------

/**
 * Append a drive-vector snapshot to the drive_log table.
 *
 * @param db      - Open better-sqlite3 Database instance.
 * @param drives  - Full computed drive array for this cycle.
 * @param dominant - Name of the dominant drive.
 * @throws ConsciousnessError on validation or write failure.
 */
export function logDrives(
  db: Database.Database,
  drives: Drive[],
  dominant: string,
): void {
  if (!Array.isArray(drives) || drives.length === 0) {
    throw new ConsciousnessError(
      'logDrives: drives must be a non-empty array',
      'consciousness_invalid_input',
      { drives, dominant },
    );
  }

  if (typeof dominant !== 'string' || dominant.trim().length === 0) {
    throw new ConsciousnessError(
      'logDrives: dominant must be a non-empty string',
      'consciousness_invalid_input',
      { dominant },
    );
  }

  let drivesJson: string;
  try {
    drivesJson = JSON.stringify(drives);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `logDrives: failed to serialise drives — ${msg}`,
      'consciousness_store_write_failed',
      { cause: msg },
    );
  }

  try {
    db.prepare(`
      INSERT INTO drive_log (drives, dominant)
      VALUES (@drives, @dominant)
    `).run({ drives: drivesJson, dominant: dominant.trim() });

    log.info({ dominant, driveCount: drives.length }, 'Drive snapshot logged');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to log drives: ${msg}`,
      'consciousness_store_write_failed',
      { dominant, cause: msg },
    );
  }
}

/**
 * Retrieve the most recent drive log entries.
 *
 * @param db    - Open better-sqlite3 Database instance.
 * @param count - Maximum number of recent entries to return (must be >= 1).
 * @returns Array of recent drive log entries, newest first.
 * @throws ConsciousnessError on validation or read failure.
 */
export function getRecentDrives(
  db: Database.Database,
  count: number,
): Array<{ drives: Drive[]; dominant: string; createdAt: string }> {
  if (!Number.isInteger(count) || count < 1) {
    throw new ConsciousnessError(
      'getRecentDrives: count must be a positive integer',
      'consciousness_invalid_input',
      { count },
    );
  }

  try {
    const rows = db.prepare(`
      SELECT drives, dominant, created_at
      FROM drive_log
      ORDER BY id DESC
      LIMIT @count
    `).all({ count }) as DriveLogRow[];

    log.debug({ requested: count, found: rows.length }, 'Fetched recent drive logs');

    return rows.map((row) => {
      let drives: Drive[] = [];
      try {
        drives = JSON.parse(row.drives) as Drive[];
      } catch {
        log.warn({ raw: row.drives.slice(0, 80) }, 'Failed to parse drives JSON from DB row');
      }

      return {
        drives,
        dominant: row.dominant,
        createdAt: row.created_at,
      };
    });
  } catch (err: unknown) {
    // Re-throw ConsciousnessError as-is; wrap anything else
    if (err instanceof ConsciousnessError) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to fetch recent drives: ${msg}`,
      'consciousness_store_read_failed',
      { count, cause: msg },
    );
  }
}
