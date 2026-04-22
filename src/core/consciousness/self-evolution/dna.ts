/**
 * @file dna.ts
 * @description Digital DNA initialisation and growth tracking.
 *
 * The DigitalDNA record is created exactly once per instance (at first boot)
 * and then mutated only through `addGrowthEvent`. It is stored in the
 * `digital_dna` key-value table.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { DigitalDNA } from './types.js';
import { getDNA, saveDNA } from './store-dna.js';

const log = createLogger('self-evolution:dna');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * All personality traits for which trait biases are initialised.
 * These names mirror the `personality_observations` table usage.
 */
const PERSONALITY_TRAITS: readonly string[] = [
  'curiosity',
  'empathy',
  'autonomy',
  'creativity',
  'discipline',
  'playfulness',
  'caution',
  'openness',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return a pseudo-random float in [min, max] using Math.random.
 * Acceptable here because trait biases are aesthetic, not cryptographic.
 */
function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Build a fresh set of trait biases in the 0.3..0.7 range.
 */
function buildTraitBiases(): Record<string, number> {
  const biases: Record<string, number> = {};
  for (const trait of PERSONALITY_TRAITS) {
    biases[trait] = parseFloat(randomInRange(0.3, 0.7).toFixed(4));
  }
  return biases;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the existing DigitalDNA, or create and persist a new one.
 *
 * The DNA is generated only once — subsequent calls return the stored record.
 *
 * @param db - Raw better-sqlite3 database instance.
 * @returns The current DigitalDNA for this instance.
 */
export function initializeDNA(db: Database.Database): DigitalDNA {
  const existing = getDNA(db);

  if (existing) {
    log.debug({ seed: existing.seed }, 'DigitalDNA already exists — reusing');
    return existing;
  }

  const dna: DigitalDNA = {
    seed: randomUUID(),
    birthDate: new Date().toISOString(),
    parentDNA: null,
    traitBiases: buildTraitBiases(),
    growthHistory: [],
  };

  saveDNA(db, dna);

  log.info({ seed: dna.seed, birthDate: dna.birthDate }, 'DigitalDNA initialised');

  return dna;
}

/**
 * Append a growth event string to the DNA's `growthHistory` array.
 *
 * Growth events are plain-text entries describing significant evolution
 * milestones (e.g. "Applied soul-update 2026-03-26: expanded curiosity section").
 *
 * @param db    - Raw better-sqlite3 database instance.
 * @param event - Non-empty description of the growth event.
 * @throws ConsciousnessError if the event is empty or DNA has not been initialised.
 */
export function addGrowthEvent(db: Database.Database, event: string): void {
  if (!event || typeof event !== 'string' || event.trim().length === 0) {
    throw new ConsciousnessError(
      'addGrowthEvent: event must be a non-empty string',
      'consciousness_evolution_invalid_dna',
      { event },
    );
  }

  const dna = getDNA(db);

  if (!dna) {
    throw new ConsciousnessError(
      'addGrowthEvent: DigitalDNA has not been initialised yet',
      'consciousness_evolution_dna_missing',
      {},
    );
  }

  const timestampedEvent = `[${new Date().toISOString()}] ${event.trim()}`;
  dna.growthHistory.push(timestampedEvent);

  saveDNA(db, dna);

  log.debug({ event: timestampedEvent, total: dna.growthHistory.length }, 'Growth event added');
}
