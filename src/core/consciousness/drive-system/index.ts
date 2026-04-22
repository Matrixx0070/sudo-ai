/**
 * @file index.ts
 * @description Public facade for the drive-system subsystem.
 *
 * DriveManager computes motivational drives, caches the latest result,
 * and provides read access to the historical drive log.
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import {
  computeDrives,
  getDominantDrive,
  getDriveInfluence,
  type DriveInfluence,
} from './drive-computer.js';
import { logDrives, getRecentDrives } from './store.js';
import type { Drive, DriveComputeInput } from './types.js';

// Re-export types for consumers
export type { Drive, DriveComputeInput } from './types.js';
export type { DriveInfluence } from './drive-computer.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('drive-system');

// ---------------------------------------------------------------------------
// DriveManager class
// ---------------------------------------------------------------------------

/**
 * High-level interface to the drive-system subsystem.
 *
 * Caches the most recently computed drive vector in memory so that
 * `getDominant()` and `getInfluence()` are O(1) between compute cycles.
 *
 * Usage:
 * ```ts
 * const dm = new DriveManager(consciousnessDB);
 * dm.compute(input);
 * const dominant = dm.getDominant();
 * const { systemPromptAddition, temperatureDelta } = dm.getInfluence();
 * dm.logCurrent();
 * ```
 */
export class DriveManager {
  private readonly db: ReturnType<ConsciousnessDB['getDb']>;
  private cachedDrives: Drive[] | null = null;

  /**
   * @param consciousnessDB - Initialised ConsciousnessDB instance.
   * @throws ConsciousnessError if the DB is not open.
   */
  constructor(consciousnessDB: ConsciousnessDB) {
    this.db = consciousnessDB.getDb();
    log.info('DriveManager initialised');
  }

  // -------------------------------------------------------------------------
  // Compute
  // -------------------------------------------------------------------------

  /**
   * Run a full drive computation cycle and cache the result.
   *
   * @param input - Normalised input signals for this cycle.
   * @returns Sorted Drive array (highest intensity first).
   * @throws ConsciousnessError on invalid input.
   */
  compute(input: DriveComputeInput): Drive[] {
    const drives = computeDrives(input);
    this.cachedDrives = drives;

    log.debug(
      { dominant: drives[0]?.name, count: drives.length },
      'Drive computation complete and cached',
    );

    return drives;
  }

  // -------------------------------------------------------------------------
  // Cache accessors
  // -------------------------------------------------------------------------

  /**
   * Return the dominant (highest-intensity) drive from the latest computation.
   *
   * @returns Dominant Drive object.
   * @throws ConsciousnessError if compute() has not been called yet.
   */
  getDominant(): Drive {
    this.assertCachePopulated('getDominant');
    return getDominantDrive(this.cachedDrives!);
  }

  /**
   * Return the system-prompt addition and temperature delta for the current
   * dominant drive.
   *
   * @returns DriveInfluence object.
   * @throws ConsciousnessError if compute() has not been called yet.
   */
  getInfluence(): DriveInfluence {
    const dominant = this.getDominant();
    return getDriveInfluence(dominant);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Persist the currently cached drive vector to the drive_log table.
   *
   * @throws ConsciousnessError if compute() has not been called yet, or on
   *         write failure.
   */
  logCurrent(): void {
    this.assertCachePopulated('logCurrent');

    const dominant = getDominantDrive(this.cachedDrives!);
    logDrives(this.db, this.cachedDrives!, dominant.name);

    log.info({ dominant: dominant.name }, 'Current drives logged to DB');
  }

  /**
   * Retrieve the most recent drive-log entries from the database.
   *
   * @param count - Maximum number of entries to return (must be >= 1).
   * @returns Array of recent drive snapshots, newest first.
   * @throws ConsciousnessError on invalid count or read failure.
   */
  getHistory(count: number): Array<{ drives: Drive[]; dominant: string; createdAt: string }> {
    if (!Number.isInteger(count) || count < 1) {
      throw new ConsciousnessError(
        'DriveManager.getHistory: count must be a positive integer',
        'consciousness_invalid_input',
        { count },
      );
    }

    return getRecentDrives(this.db, count);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private assertCachePopulated(caller: string): void {
    if (!this.cachedDrives) {
      throw new ConsciousnessError(
        `DriveManager.${caller}: no drive data — call compute() first`,
        'consciousness_drive_not_computed',
        { caller },
      );
    }
  }
}
