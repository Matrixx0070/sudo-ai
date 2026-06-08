/**
 * Predictor — SUDO-AI Predictive Intelligence engine.
 *
 * Anticipates the owner's needs, forecasts viral topics, simulates decisions,
 * and detects metric anomalies. Backed by better-sqlite3 (mind.db).
 *
 * Heavy async logic lives in predictor-logic.ts to stay within the 300-line
 * file boundary. Schema, types, and DDL live in predictor-schema.ts.
 *
 * SCOPE: these forecasts are content-creator / cost-ops specific (YouTube upload
 * windows, viral topics, API spend). The engine is always available on demand via
 * the meta.predictor tool. It can ALSO be surfaced proactively in the agent loop
 * as an advisory "# HEADS UP" on the first turn of a session, but ONLY via the
 * opt-in, default-OFF SUDO_PREDICTOR_LOOP flag (see AgentLoop.run). Do not wire it
 * into the general loop unconditionally — these forecasts are noise for owners who
 * are not content creators.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  DDL_PREDICTIONS, DDL_ANOMALIES,
  DDL_IDX_PREDICTIONS_TYPE, DDL_IDX_PREDICTIONS_OUTCOME, DDL_IDX_ANOMALIES_SEVERITY,
  rowToPrediction,
  type Prediction, type Anomaly, type PredictionRow,
} from './predictor-schema.js';
import {
  runAnticipate, runPredictViralTopic, runSimulate, runDetectAnomalies,
} from './predictor-logic.js';

export type { Prediction, Anomaly } from './predictor-schema.js';

const logger = createLogger('predictor');

export class Predictor {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (!dbPath?.trim()) throw new TypeError('Predictor: dbPath must be a non-empty string');
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(DDL_PREDICTIONS);
    this.db.exec(DDL_ANOMALIES);
    this.db.exec(DDL_IDX_PREDICTIONS_TYPE);
    this.db.exec(DDL_IDX_PREDICTIONS_OUTCOME);
    this.db.exec(DDL_IDX_ANOMALIES_SEVERITY);
    logger.info({ dbPath }, 'Predictor initialised');
  }

  // -------------------------------------------------------------------------
  // Store / retrieve
  // -------------------------------------------------------------------------

  storePrediction(p: Prediction): void {
    if (!p.id?.trim()) throw new TypeError('storePrediction: id is required');
    if (!p.type) throw new TypeError('storePrediction: type is required');
    if (!p.prediction?.trim()) throw new TypeError('storePrediction: prediction is required');

    this.db.prepare(`
      INSERT OR REPLACE INTO predictions
        (id, type, prediction, confidence, reasoning, suggested_action,
         expires_at, outcome, created_at)
      VALUES (@id, @type, @prediction, @confidence, @reasoning,
              @suggestedAction, @expiresAt, @outcome, @createdAt)
    `).run({
      id: p.id, type: p.type, prediction: p.prediction,
      confidence: Math.min(1, Math.max(0, p.confidence)),
      reasoning: p.reasoning ?? null,
      suggestedAction: p.suggestedAction ?? null,
      expiresAt: p.expiresAt ?? null,
      outcome: p.outcome ?? 'pending',
      createdAt: p.createdAt,
    });
    logger.debug({ id: p.id, type: p.type }, 'Prediction stored');
  }

  getRecentPredictions(limit = 20): Prediction[] {
    const n = Math.min(Math.max(1, Math.floor(limit)), 200);
    return (this.db.prepare(
      `SELECT * FROM predictions ORDER BY created_at DESC LIMIT ?`
    ).all(n) as PredictionRow[]).map(rowToPrediction);
  }

  getPendingPredictions(): Prediction[] {
    return (this.db.prepare(
      `SELECT * FROM predictions WHERE outcome = 'pending' ORDER BY created_at DESC`
    ).all() as PredictionRow[]).map(rowToPrediction);
  }

  // -------------------------------------------------------------------------
  // Outcome tracking
  // -------------------------------------------------------------------------

  recordOutcome(predictionId: string, outcome: 'correct' | 'incorrect'): void {
    if (!predictionId?.trim()) throw new TypeError('recordOutcome: predictionId is required');
    if (outcome !== 'correct' && outcome !== 'incorrect') {
      throw new TypeError(`recordOutcome: must be 'correct' or 'incorrect', got: ${outcome}`);
    }
    const info = this.db.prepare(
      `UPDATE predictions SET outcome = @outcome WHERE id = @id`
    ).run({ outcome, id: predictionId });
    if (info.changes === 0) {
      logger.warn({ predictionId }, 'recordOutcome: prediction not found');
    } else {
      logger.info({ predictionId, outcome }, 'Prediction outcome recorded');
    }
  }

  getAccuracy(): { total: number; correct: number; rate: number } {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) AS correct
      FROM predictions WHERE outcome != 'pending'
    `).get() as { total: number; correct: number };
    const total = row.total ?? 0;
    const correct = row.correct ?? 0;
    return { total, correct, rate: total > 0 ? Math.round((correct / total) * 10000) / 100 : 0 };
  }

  // -------------------------------------------------------------------------
  // Anticipatory execution — delegates to predictor-logic
  // -------------------------------------------------------------------------

  async anticipate(): Promise<Prediction[]> {
    const predictions = await runAnticipate(this.db);
    for (const p of predictions) this.storePrediction(p);
    return predictions;
  }

  // -------------------------------------------------------------------------
  // Viral topic prediction — delegates to predictor-logic
  // -------------------------------------------------------------------------

  async predictViralTopic(): Promise<Prediction> {
    const p = await runPredictViralTopic(this.db);
    this.storePrediction(p);
    logger.info({ id: p.id, confidence: p.confidence }, 'Viral topic prediction stored');
    return p;
  }

  // -------------------------------------------------------------------------
  // Decision simulation — delegates to predictor-logic
  // -------------------------------------------------------------------------

  async simulate(
    scenario: string,
    options: string[]
  ): Promise<Array<{ option: string; projectedOutcome: string; confidence: number }>> {
    if (!scenario?.trim()) throw new TypeError('simulate: scenario is required');
    if (!Array.isArray(options) || options.length === 0) {
      throw new TypeError('simulate: options array must be non-empty');
    }
    if (options.length > 10) throw new RangeError('simulate: maximum 10 options');
    return runSimulate(scenario, options);
  }

  // -------------------------------------------------------------------------
  // Anomaly detection — delegates to predictor-logic
  // -------------------------------------------------------------------------

  async detectAnomalies(): Promise<Anomaly[]> {
    return runDetectAnomalies(this.db, () => this.getAccuracy(), a => this._storeAnomaly(a));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _storeAnomaly(a: Anomaly): Anomaly {
    this.db.prepare(`
      INSERT INTO anomalies (metric, expected, actual, deviation, severity, description)
      VALUES (@metric, @expected, @actual, @deviation, @severity, @description)
    `).run(a);
    logger.warn({ metric: a.metric, severity: a.severity, deviation: a.deviation }, 'Anomaly detected');
    return a;
  }
}
