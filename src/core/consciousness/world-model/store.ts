/**
 * @file store.ts
 * @description SQLite persistence helpers for the world-model sub-module.
 * Delegates all statement preparation to store-stmts.ts.
 * All public functions are synchronous (better-sqlite3 API).
 */

import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { WorldModelEntry } from './types.js';
import { getStatements, rowToEntry, type WorldModelRow } from './store-stmts.js';

const log = createLogger('consciousness:world-model:store');

/** Persist a WorldModelEntry to the `world_model` table. */
export function savePrediction(cdb: ConsciousnessDB, entry: WorldModelEntry): void {
  if (!entry?.id || typeof entry.id !== 'string') {
    throw new ConsciousnessError(
      'savePrediction: entry must have a valid id',
      'consciousness_world_model_invalid_entry',
      { entryId: entry?.id },
    );
  }
  if (!entry.domain || typeof entry.domain !== 'string') {
    throw new ConsciousnessError(
      'savePrediction: entry must have a non-empty domain',
      'consciousness_world_model_invalid_entry',
      { entryId: entry.id },
    );
  }
  if (!entry.prediction || typeof entry.prediction !== 'string') {
    throw new ConsciousnessError(
      'savePrediction: entry must have a non-empty prediction',
      'consciousness_world_model_invalid_entry',
      { entryId: entry.id },
    );
  }
  if (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1) {
    throw new ConsciousnessError(
      `savePrediction: confidence must be in [0,1], got ${entry.confidence}`,
      'consciousness_world_model_invalid_confidence',
      { entryId: entry.id, confidence: entry.confidence },
    );
  }
  try {
    const { insert } = getStatements(cdb.getDb());
    insert.run([
      entry.id, entry.domain, entry.prediction, entry.confidence,
      entry.evidenceCount, entry.madeAt, entry.expiresAt,
      entry.lastValidated, entry.outcome, entry.actualResult,
    ]);
    log.debug({ id: entry.id, domain: entry.domain }, 'Prediction saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `savePrediction failed: ${msg}`,
      'consciousness_world_model_save_failed',
      { entryId: entry.id, cause: msg },
    );
  }
}

/** Retrieve predictions, optionally filtered by domain and/or outcome. */
export function getPredictions(
  cdb: ConsciousnessDB,
  domain?: string,
  outcome?: string,
): WorldModelEntry[] {
  try {
    const stmts = getStatements(cdb.getDb());
    let rows: WorldModelRow[];
    if (domain && outcome) {
      rows = stmts.getByDomainOutcome.all([domain, outcome]) as WorldModelRow[];
    } else if (domain) {
      rows = stmts.getByDomain.all(domain) as WorldModelRow[];
    } else if (outcome) {
      rows = stmts.getByOutcome.all(outcome) as WorldModelRow[];
    } else {
      rows = stmts.getAll.all([]) as WorldModelRow[];
    }
    return rows.map(rowToEntry);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getPredictions failed: ${msg}`,
      'consciousness_world_model_read_failed',
      { domain, outcome, cause: msg },
    );
  }
}

/** Retrieve all predictions with outcome='pending', ordered by madeAt ASC. */
export function getPending(cdb: ConsciousnessDB): WorldModelEntry[] {
  try {
    const { getPending: stmt } = getStatements(cdb.getDb());
    const rows = stmt.all([]) as WorldModelRow[];
    return rows.map(rowToEntry);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getPending failed: ${msg}`,
      'consciousness_world_model_read_failed',
      { cause: msg },
    );
  }
}

/** Retrieve a single prediction by id, or null if not found. */
export function getById(cdb: ConsciousnessDB, id: string): WorldModelEntry | null {
  if (!id || typeof id !== 'string') {
    throw new ConsciousnessError(
      'getById: id must be a non-empty string',
      'consciousness_world_model_invalid_entry',
      { id },
    );
  }
  try {
    const { getById: stmt } = getStatements(cdb.getDb());
    const row = stmt.get(id) as WorldModelRow | undefined;
    return row ? rowToEntry(row) : null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getById failed: ${msg}`,
      'consciousness_world_model_read_failed',
      { id, cause: msg },
    );
  }
}

/**
 * Update outcome, actualResult, and confidence for a prediction.
 * Increments evidence_count and sets last_validated to now in the DB.
 */
export function updateOutcome(
  cdb: ConsciousnessDB,
  id: string,
  outcome: string,
  actualResult: string,
  confidence: number,
): void {
  if (!id || typeof id !== 'string') {
    throw new ConsciousnessError(
      'updateOutcome: id must be a non-empty string',
      'consciousness_world_model_invalid_entry',
      { id },
    );
  }
  if (!['pending', 'confirmed', 'violated', 'expired'].includes(outcome)) {
    throw new ConsciousnessError(
      `updateOutcome: invalid outcome "${outcome}"`,
      'consciousness_world_model_invalid_outcome',
      { id, outcome },
    );
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new ConsciousnessError(
      `updateOutcome: confidence must be in [0,1], got ${confidence}`,
      'consciousness_world_model_invalid_confidence',
      { id, confidence },
    );
  }
  try {
    const { updateOutcome: stmt } = getStatements(cdb.getDb());
    const result = stmt.run([outcome, actualResult, confidence, id]);
    if (result.changes === 0) {
      log.warn({ id, outcome }, 'updateOutcome: no row matched id');
    } else {
      log.debug({ id, outcome, confidence }, 'Prediction outcome updated');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `updateOutcome failed: ${msg}`,
      'consciousness_world_model_update_failed',
      { id, outcome, cause: msg },
    );
  }
}

/**
 * Set outcome='expired' on all pending predictions past their expires_at.
 * Returns the number of rows updated.
 */
export function expireOld(cdb: ConsciousnessDB): number {
  try {
    const { expireOld: stmt } = getStatements(cdb.getDb());
    const result = stmt.run([]);
    const expired = result.changes;
    if (expired > 0) log.info({ expired }, 'Old predictions expired');
    return expired;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `expireOld failed: ${msg}`,
      'consciousness_world_model_expire_failed',
      { cause: msg },
    );
  }
}

/**
 * Return AVG(confidence) for confirmed/violated predictions in a domain.
 * Returns 0.5 when no resolved predictions exist.
 */
export function getConfidenceForDomain(cdb: ConsciousnessDB, domain: string): number {
  if (!domain || typeof domain !== 'string') {
    throw new ConsciousnessError(
      'getConfidenceForDomain: domain must be a non-empty string',
      'consciousness_world_model_invalid_domain',
      { domain },
    );
  }
  try {
    const { avgConfidence } = getStatements(cdb.getDb());
    const row = avgConfidence.get(domain) as { avg_confidence: number } | undefined;
    const avg = row?.avg_confidence ?? 0.5;
    log.debug({ domain, avg }, 'Domain confidence calculated');
    return avg;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getConfidenceForDomain failed: ${msg}`,
      'consciousness_world_model_read_failed',
      { domain, cause: msg },
    );
  }
}

/**
 * Empirical match rate for a domain: `confirmed / (confirmed + violated)`.
 * Unlike getConfidenceForDomain (which averages the stored confidence values),
 * this is the raw outcome frequency — the true base rate the predictor should
 * converge toward. Returns `{ rate, resolved }`; `resolved` is the sample size
 * so callers can apply a cold-start floor, and `rate` is 0.5 when nothing has
 * resolved yet.
 */
export function getDomainMatchRate(
  cdb: ConsciousnessDB,
  domain: string,
): { rate: number; resolved: number } {
  if (!domain || typeof domain !== 'string') {
    throw new ConsciousnessError(
      'getDomainMatchRate: domain must be a non-empty string',
      'consciousness_world_model_invalid_domain',
      { domain },
    );
  }
  try {
    const { matchRate } = getStatements(cdb.getDb());
    const row = matchRate.get(domain) as { confirmed: number | null; resolved: number } | undefined;
    const resolved = row?.resolved ?? 0;
    const confirmed = row?.confirmed ?? 0;
    const rate = resolved > 0 ? confirmed / resolved : 0.5;
    log.debug({ domain, rate, resolved }, 'Domain match rate calculated');
    return { rate, resolved };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `getDomainMatchRate failed: ${msg}`,
      'consciousness_world_model_read_failed',
      { domain, cause: msg },
    );
  }
}
