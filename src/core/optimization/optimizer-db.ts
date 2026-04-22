/**
 * optimizer-db.ts — Database helpers for AutoOptimizer.
 *
 * Owns schema initialisation and the statistical rule-derivation logic,
 * keeping auto-optimizer.ts focused on the public class API.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('optimizer-db');

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface OptimizationRule {
  id: string;
  dimension: string;
  rule: string;
  evidence: string;
  strength: number;
  active: boolean;
  createdAt: string;
}

export interface ContentDecision {
  id: string;
  dimension: string;
  chosenValue: string;
  alternatives: string[];
  reasoning: string;
  confidence: number;
  basedOnVideos: number;
  createdAt: string;
}

export interface ContentBlueprint {
  topic: string;
  hookType: string;
  thumbnailStyle: string;
  targetDuration: number;
  postingTime: string;
  musicMood: string;
  decisions: ContentDecision[];
  expectedPerformance: { views: number; ctr: number; retention: number };
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

export interface RuleRow {
  id: string;
  dimension: string;
  rule: string;
  evidence: string;
  strength: number;
  active: number;
  created_at: string;
}

export interface DecisionRow {
  id: string;
  dimension: string;
  chosen_value: string;
  alternatives: string;
  reasoning: string;
  confidence: number;
  based_on_videos: number;
  outcome: string | null;
  created_at: string;
}

interface PerfRow {
  dim_value: string;
  avg_views: number;
  avg_ctr: number;
  avg_retention: number;
  sample_size: number;
}

// ---------------------------------------------------------------------------
// Column map — only dimensions with a real DB column in video_performance
// ---------------------------------------------------------------------------

export const DIM_COLUMN: Record<string, string> = {
  hook_type: 'hook_type',
  thumbnail_style: 'thumbnail_style',
  topic: 'topic',
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS optimization_rules (
      id TEXT PRIMARY KEY,
      dimension TEXT NOT NULL,
      rule TEXT NOT NULL,
      evidence TEXT NOT NULL,
      strength REAL DEFAULT 0.5,
      active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS content_decisions (
      id TEXT PRIMARY KEY,
      dimension TEXT NOT NULL,
      chosen_value TEXT NOT NULL,
      alternatives TEXT DEFAULT '[]',
      reasoning TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      based_on_videos INTEGER DEFAULT 0,
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS content_blueprints (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      blueprint TEXT NOT NULL,
      expected_performance TEXT DEFAULT '{}',
      actual_performance TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  logger.debug('Optimization schema initialised');
}

// ---------------------------------------------------------------------------
// Rule loading
// ---------------------------------------------------------------------------

export function loadRulesFromDb(db: Database.Database): Map<string, OptimizationRule> {
  const rows = db.prepare('SELECT * FROM optimization_rules').all() as RuleRow[];
  const map = new Map<string, OptimizationRule>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id, dimension: row.dimension, rule: row.rule,
      evidence: row.evidence, strength: row.strength,
      active: row.active === 1, createdAt: row.created_at,
    });
  }
  logger.debug({ count: map.size }, 'Rules loaded from DB');
  return map;
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

/** Cohen's d-inspired strength: 0..1 based on effect ratio and sample size. */
export function computeStrength(effectRatio: number, sampleSize: number): number {
  const effectScore = Math.min(1, Math.max(0, (effectRatio - 1) / 2));
  const sampleScore = Math.min(1, sampleSize / 30);
  return Math.round((effectScore * 0.6 + sampleScore * 0.4) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Rule derivation
// ---------------------------------------------------------------------------

export function deriveRulesForDimension(
  db: Database.Database,
  dim: string,
  col: string,
  generateId: () => string,
): OptimizationRule | null {
  const rows = db.prepare(`
    SELECT ${col} AS dim_value,
           AVG(views)               AS avg_views,
           AVG(ctr)                 AS avg_ctr,
           AVG(avg_view_percentage) AS avg_retention,
           COUNT(*)                 AS sample_size
    FROM video_performance
    WHERE ${col} IS NOT NULL AND ${col} != '' AND views > 0
    GROUP BY ${col}
    HAVING COUNT(*) >= 3
    ORDER BY avg_ctr DESC
  `).all() as PerfRow[];

  if (rows.length < 2) return null;

  const best = rows[0]!;
  const worst = rows[rows.length - 1]!;
  const overallCtr = rows.reduce((s, r) => s + r.avg_ctr, 0) / rows.length;
  if (overallCtr === 0) return null;

  const effectRatio = best.avg_ctr / (worst.avg_ctr || overallCtr || 1);
  const totalSamples = rows.reduce((s, r) => s + r.sample_size, 0);
  const strength = computeStrength(effectRatio, totalSamples);
  if (strength < 0.1) return null;

  const ruleText = `prefer ${dim}="${best.dim_value}" over "${worst.dim_value}"`;
  const evidence =
    `${dim}: ${best.dim_value} CTR=${(best.avg_ctr * 100).toFixed(2)}% ` +
    `vs ${worst.dim_value} CTR=${(worst.avg_ctr * 100).toFixed(2)}% ` +
    `(n=${totalSamples}, samples: ${rows.map(r => `${r.dim_value}:${r.sample_size}`).join(', ')})`;

  // Upsert: replace old rule for same dimension
  db.prepare('DELETE FROM optimization_rules WHERE dimension = ?').run(dim);

  const rule: OptimizationRule = {
    id: generateId(), dimension: dim,
    rule: ruleText, evidence,
    strength, active: true,
    createdAt: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO optimization_rules (id, dimension, rule, evidence, strength, active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(rule.id, rule.dimension, rule.rule, rule.evidence, rule.strength, rule.createdAt);

  logger.info({ dimension: dim, strength, best: best.dim_value }, 'Rule derived');
  return rule;
}

// ---------------------------------------------------------------------------
// Improvement metrics
// ---------------------------------------------------------------------------

export function queryImprovementMetrics(db: Database.Database): {
  beforeOptimization: number;
  afterOptimization: number;
  improvementPercent: number;
} {
  const tableExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='video_performance'`,
  ).get();

  if (!tableExists) return { beforeOptimization: 0, afterOptimization: 0, improvementPercent: 0 };

  const firstRule = db.prepare(
    'SELECT created_at FROM optimization_rules ORDER BY created_at ASC LIMIT 1',
  ).get() as { created_at: string } | undefined;

  if (!firstRule) {
    const avg = db.prepare('SELECT AVG(ctr) AS avg_ctr FROM video_performance WHERE views > 0')
      .get() as { avg_ctr: number } | undefined;
    const baseline = avg?.avg_ctr ?? 0;
    return { beforeOptimization: baseline, afterOptimization: baseline, improvementPercent: 0 };
  }

  const cutoff = firstRule.created_at;
  const before = db.prepare(
    'SELECT AVG(ctr) AS avg_ctr FROM video_performance WHERE views > 0 AND fetched_at < ?',
  ).get(cutoff) as { avg_ctr: number } | undefined;
  const after = db.prepare(
    'SELECT AVG(ctr) AS avg_ctr FROM video_performance WHERE views > 0 AND fetched_at >= ?',
  ).get(cutoff) as { avg_ctr: number } | undefined;

  const beforeVal = before?.avg_ctr ?? 0;
  const afterVal = after?.avg_ctr ?? 0;
  const improvement = beforeVal > 0
    ? Math.round(((afterVal - beforeVal) / beforeVal) * 10000) / 100
    : 0;

  return { beforeOptimization: beforeVal, afterOptimization: afterVal, improvementPercent: improvement };
}
