/**
 * @file store-dna.ts
 * @description SQLite persistence for the DigitalDNA record.
 *
 * Uses the `digital_dna` key-value table (defined in consciousness-db.ts).
 * Separated from store.ts to keep file sizes within the 300-line limit.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { DigitalDNA } from './types.js';

const log = createLogger('self-evolution:store-dna');

const DNA_KEY = 'dna';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the stored DigitalDNA record, or return null if none exists.
 *
 * @param db - Raw better-sqlite3 database instance.
 * @returns The persisted DigitalDNA, or null on first boot.
 */
export function getDNA(db: Database.Database): DigitalDNA | null {
  try {
    const row = db.prepare(`SELECT value FROM digital_dna WHERE key = ?`).get(DNA_KEY) as
      | { value: string }
      | undefined;

    if (!row) return null;

    return JSON.parse(row.value) as DigitalDNA;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to load DigitalDNA: ${msg}`,
      'consciousness_evolution_store_error',
      { cause: msg },
    );
  }
}

/**
 * Persist the DigitalDNA record using INSERT OR REPLACE.
 *
 * @param db  - Raw better-sqlite3 database instance.
 * @param dna - The DigitalDNA record to store.
 * @throws ConsciousnessError if dna lacks required fields or on DB failure.
 */
export function saveDNA(db: Database.Database, dna: DigitalDNA): void {
  if (!dna.seed || !dna.birthDate) {
    throw new ConsciousnessError(
      'saveDNA: dna must have seed and birthDate',
      'consciousness_evolution_invalid_dna',
      { seed: dna.seed },
    );
  }

  try {
    db.prepare(`
      INSERT OR REPLACE INTO digital_dna (key, value) VALUES (?, ?)
    `).run(DNA_KEY, JSON.stringify(dna));

    log.debug({ seed: dna.seed }, 'DigitalDNA saved');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `Failed to save DigitalDNA: ${msg}`,
      'consciousness_evolution_store_error',
      { cause: msg },
    );
  }
}
