/**
 * @file model.ts
 * @description SelfModel — the AI's persistent self-representation.
 * DB I/O delegated to store.ts; computation delegated to assessor.ts.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { CapabilityAssessment } from '../types.js';
import type { EpisodeLike } from './types.js';
import {
  upsertCapability,
  getCapabilities,
  getByTrend,
  getPersonalityTraits,
  savePersonalityObservation,
  LEVEL_MAP,
} from './store.js';
import {
  assessFromEpisode,
  computePersonalityFromHistory,
} from './assessor.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('self-model:model');

// ---------------------------------------------------------------------------
// SelfModel
// ---------------------------------------------------------------------------

export class SelfModel {
  private readonly db: Database.Database;

  /**
   * @param cdb - Open ConsciousnessDB instance.  Must remain open for the
   *              lifetime of this SelfModel.
   * @throws ConsciousnessError if the database is not open.
   */
  constructor(cdb: ConsciousnessDB) {
    if (!cdb) {
      throw new ConsciousnessError(
        'SelfModel: cdb must be a ConsciousnessDB instance',
        'consciousness_self_model_invalid_db',
      );
    }
    this.db = cdb.getDb();
    log.info('SelfModel initialised');
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  /** Incorporate a new episode into the self-model (capability + personality). */
  updateFromEpisode(episode: EpisodeLike): void {
    if (!episode || !episode.topic) {
      throw new ConsciousnessError(
        'updateFromEpisode: episode must have a non-empty topic',
        'consciousness_self_model_invalid_episode',
        { episode },
      );
    }

    log.debug({ domain: episode.topic, outcome: episode.outcome }, 'Updating from episode');
    const current = this._getAssessmentForDomain(episode.topic);
    const updated = assessFromEpisode(episode, current);
    upsertCapability(this.db, updated);

    const traitObservations = computePersonalityFromHistory([episode]);
    for (const obs of traitObservations) {
      savePersonalityObservation(this.db, obs.trait, obs.value, `episode:${episode.id}`);
    }
    log.debug({ domain: episode.topic, confidence: updated.confidence }, 'Self-model updated');
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Top-N capabilities where success > failure, ordered by confidence desc. */
  getStrengths(count: number = 5): CapabilityAssessment[] {
    this._validateCount(count, 'getStrengths');

    const all = getCapabilities(this.db);
    return all
      .filter((a) => (a as { successCount: number }).successCount > (a as { failureCount: number }).failureCount)
      .sort((x, y) => y.confidence - x.confidence)
      .slice(0, count);
  }

  /** Bottom-N capabilities where failure > success, ordered by confidence asc. */
  getWeaknesses(count: number = 5): CapabilityAssessment[] {
    this._validateCount(count, 'getWeaknesses');

    const all = getCapabilities(this.db);
    return all
      .filter((a) => (a as { failureCount: number }).failureCount > (a as { successCount: number }).successCount)
      .sort((x, y) => x.confidence - y.confidence)
      .slice(0, count);
  }

  /** All capabilities with trend === 'improving'. */
  getGrowthAreas(): CapabilityAssessment[] {
    return getByTrend(this.db, 'improving');
  }

  /** Average personality trait values over the last 30 days. */
  getPersonalityTraits(): Record<string, number> {
    return getPersonalityTraits(this.db);
  }

  /** Mean confidence across all assessments; 0.5 baseline when empty. */
  getOverallConfidence(): number {
    const all = getCapabilities(this.db);
    if (all.length === 0) return 0.5;

    const sum = all.reduce((acc, a) => acc + a.confidence, 0);
    return Math.round((sum / all.length) * 1000) / 1000;
  }

  // -------------------------------------------------------------------------
  // Prompt integration
  // -------------------------------------------------------------------------

  /** Formatted self-awareness block for system prompt injection. */
  toPromptSummary(): string {
    const strengths = this.getStrengths(3);
    const growth = this.getGrowthAreas();
    const weaknesses = this.getWeaknesses(2);
    const traits = this.getPersonalityTraits();
    const overallConf = this.getOverallConfidence();

    const lines: string[] = ['Self-awareness:'];

    lines.push(
      'Strengths: ' +
        (strengths.length > 0
          ? strengths.map((s) => `${s.domain} (${pct(s.confidence)})`).join(', ')
          : 'none yet'),
    );

    lines.push(
      'Improving: ' +
        (growth.length > 0 ? growth.map((g) => g.domain).join(', ') : 'none'),
    );

    lines.push(
      'Weaknesses: ' +
        (weaknesses.length > 0
          ? weaknesses.map((w) => `${w.domain} (${pct(w.confidence)})`).join(', ')
          : 'none identified'),
    );

    const traitEntries = Object.entries(traits);
    lines.push(
      'Personality: ' +
        (traitEntries.length > 0
          ? traitEntries.map(([t, v]) => `${t} (${v.toFixed(2)})`).join(', ')
          : 'undetermined'),
    );

    lines.push(`Overall confidence: ${pct(overallConf)}`);

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _getAssessmentForDomain(
    domain: string,
  ): (CapabilityAssessment & { successCount: number; failureCount: number }) | null {
    try {
      const row = this.db
        .prepare('SELECT * FROM capability_assessments WHERE domain = ?')
        .get(domain) as
        | {
            domain: string;
            level: string;
            confidence: number;
            evidence_count: number;
            success_count: number;
            failure_count: number;
            trend: string;
            last_assessed: string;
          }
        | undefined;

      if (!row) return null;

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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(
        `_getAssessmentForDomain DB error: ${msg}`,
        'consciousness_self_model_db_read',
        { domain, cause: msg },
      );
    }
  }

  private _validateCount(count: number, caller: string): void {
    if (typeof count !== 'number' || count < 1 || !Number.isFinite(count)) {
      throw new ConsciousnessError(
        `${caller}: count must be a positive finite number`,
        'consciousness_self_model_invalid_count',
        { count },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
