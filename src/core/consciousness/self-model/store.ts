/**
 * @file store.ts
 * @description DB access layer for the self-model subsystem.
 * Tables: capability_assessments, personality_observations (see consciousness-db.ts).
 * Synchronous better-sqlite3 API throughout — no async/await.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { CapabilityAssessment } from '../types.js';

const log = createLogger('self-model:store');

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface CapabilityRow {
  domain: string;
  level: string;
  confidence: number;
  evidence_count: number;
  success_count: number;
  failure_count: number;
  trend: string;
  last_assessed: string;
}

interface PersonalityRow {
  trait: string;
  avg_value: number;
}

// Level text → numeric 0..1 map (shared by rowToCapability and model.ts)
export const LEVEL_MAP: Record<string, number> = {
  novice: 0.1,
  developing: 0.3,
  competent: 0.5,
  proficient: 0.7,
  expert: 0.9,
};

// ---------------------------------------------------------------------------
// Row converter
// ---------------------------------------------------------------------------

function rowToCapability(
  row: CapabilityRow,
): CapabilityAssessment & { successCount: number; failureCount: number } {
  return {
    domain: row.domain,
    level: LEVEL_MAP[row.level] ?? 0.3,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    trend: row.trend as CapabilityAssessment['trend'],
    lastAssessed: row.last_assessed,
    successCount: row.success_count,
    failureCount: row.failure_count,
  };
}

// ---------------------------------------------------------------------------
// Capability CRUD
// ---------------------------------------------------------------------------

/** Insert or replace a capability assessment. Throws ConsciousnessError on failure. */
export function upsertCapability(
  db: Database.Database,
  assessment: CapabilityAssessment & { successCount?: number; failureCount?: number },
): void {
  if (!assessment.domain || typeof assessment.domain !== 'string') {
    throw new ConsciousnessError(
      'upsertCapability: domain must be a non-empty string',
      'consciousness_self_model_invalid_domain',
      { domain: assessment.domain },
    );
  }
  try {
    db.prepare(
      `INSERT OR REPLACE INTO capability_assessments
         (domain, level, confidence, evidence_count, success_count, failure_count, trend, last_assessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      assessment.domain,
      numericLevelToLabel(assessment.level),
      clamp01(assessment.confidence),
      assessment.evidenceCount ?? 0,
      assessment.successCount ?? 0,
      assessment.failureCount ?? 0,
      assessment.trend,
      assessment.lastAssessed,
    );
    log.debug({ domain: assessment.domain }, 'Capability upserted');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(`upsertCapability DB error: ${msg}`,
      'consciousness_self_model_db_write', { domain: assessment.domain, cause: msg });
  }
}

/** Retrieve all capability assessments ordered by confidence desc. */
export function getCapabilities(
  db: Database.Database,
): Array<CapabilityAssessment & { successCount: number; failureCount: number }> {
  try {
    const rows = db
      .prepare('SELECT * FROM capability_assessments ORDER BY confidence DESC')
      .all() as CapabilityRow[];
    return rows.map(rowToCapability);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(`getCapabilities DB error: ${msg}`,
      'consciousness_self_model_db_read', { cause: msg });
  }
}

/** Retrieve capability assessments filtered by text-level label (e.g. 'expert'). */
export function getByLevel(
  db: Database.Database,
  level: string,
): Array<CapabilityAssessment & { successCount: number; failureCount: number }> {
  if (!level || typeof level !== 'string') {
    throw new ConsciousnessError('getByLevel: level must be a non-empty string',
      'consciousness_self_model_invalid_level', { level });
  }
  try {
    const rows = db
      .prepare('SELECT * FROM capability_assessments WHERE level = ? ORDER BY confidence DESC')
      .all(level) as CapabilityRow[];
    return rows.map(rowToCapability);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(`getByLevel DB error: ${msg}`,
      'consciousness_self_model_db_read', { level, cause: msg });
  }
}

/** Retrieve capability assessments filtered by trend ('improving' | 'stable' | 'declining'). */
export function getByTrend(
  db: Database.Database,
  trend: string,
): Array<CapabilityAssessment & { successCount: number; failureCount: number }> {
  if (!trend || typeof trend !== 'string') {
    throw new ConsciousnessError('getByTrend: trend must be a non-empty string',
      'consciousness_self_model_invalid_trend', { trend });
  }
  try {
    const rows = db
      .prepare('SELECT * FROM capability_assessments WHERE trend = ? ORDER BY confidence DESC')
      .all(trend) as CapabilityRow[];
    return rows.map(rowToCapability);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(`getByTrend DB error: ${msg}`,
      'consciousness_self_model_db_read', { trend, cause: msg });
  }
}

// ---------------------------------------------------------------------------
// Personality observations
// ---------------------------------------------------------------------------

/** Insert a single personality observation row. */
export function savePersonalityObservation(
  db: Database.Database,
  trait: string,
  value: number,
  source: string,
): void {
  if (!trait || typeof trait !== 'string') {
    throw new ConsciousnessError('savePersonalityObservation: trait must be a non-empty string',
      'consciousness_self_model_invalid_trait', { trait });
  }
  if (typeof value !== 'number' || value < 0 || value > 1) {
    throw new ConsciousnessError('savePersonalityObservation: value must be in [0, 1]',
      'consciousness_self_model_invalid_value', { trait, value });
  }
  if (!source || typeof source !== 'string') {
    throw new ConsciousnessError('savePersonalityObservation: source must be a non-empty string',
      'consciousness_self_model_invalid_source', { trait, source });
  }
  try {
    db.prepare('INSERT INTO personality_observations (trait, value, source) VALUES (?, ?, ?)')
      .run(trait, clamp01(value), source);
    log.debug({ trait, value }, 'Personality observation saved');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(`savePersonalityObservation DB error: ${msg}`,
      'consciousness_self_model_db_write', { trait, cause: msg });
  }
}

/**
 * Average value per trait from personality_observations in the last 30 days.
 * Traits with no recent observations are excluded.
 */
export function getPersonalityTraits(db: Database.Database): Record<string, number> {
  try {
    // personality_observations.created_at is ISO-8601; use strftime, not datetime('now').
    const rows = db.prepare(
      `SELECT trait, AVG(value) AS avg_value
         FROM personality_observations
        WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
        GROUP BY trait
        ORDER BY avg_value DESC`,
    ).all() as PersonalityRow[];

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.trait] = Math.round(row.avg_value * 1000) / 1000;
    }
    log.debug({ traitCount: rows.length }, 'Personality traits loaded');
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(`getPersonalityTraits DB error: ${msg}`,
      'consciousness_self_model_db_read', { cause: msg });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Convert numeric level [0..1] to text label for DB storage. */
export function numericLevelToLabel(level: number): string {
  if (level < 0.2) return 'novice';
  if (level < 0.4) return 'developing';
  if (level < 0.6) return 'competent';
  if (level < 0.8) return 'proficient';
  return 'expert';
}
