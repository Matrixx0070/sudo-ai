/**
 * Closed-Loop Auto-Optimizer — feeds performance data back into production decisions.
 *
 * The missing link: analysis → automatic adjustment → better content.
 * No human glue required between performance data and next video's parameters.
 *
 * Heavy DB helpers live in optimizer-db.ts. This file owns the public class API.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  initSchema, loadRulesFromDb, deriveRulesForDimension,
  queryImprovementMetrics, DIM_COLUMN,
  type OptimizationRule, type ContentDecision, type ContentBlueprint,
  type RuleRow, type DecisionRow,
} from './optimizer-db.js';

export type { OptimizationRule, ContentDecision, ContentBlueprint };

const logger = createLogger('auto-optimizer');

// ---------------------------------------------------------------------------
// AutoOptimizer
// ---------------------------------------------------------------------------

export class AutoOptimizer {
  private db: Database.Database;
  private rules: Map<string, OptimizationRule>;

  constructor(private readonly dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    initSchema(this.db);
    this.rules = loadRulesFromDb(this.db);
    logger.info({ dbPath }, 'AutoOptimizer initialised');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private generateId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ---------------------------------------------------------------------------
  // learnFromHistory
  // ---------------------------------------------------------------------------

  async learnFromHistory(): Promise<OptimizationRule[]> {
    logger.info('learnFromHistory: scanning video_performance');

    const tableExists = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='video_performance'`,
    ).get();

    if (!tableExists) {
      logger.warn('video_performance table not found — no data to learn from');
      return [];
    }

    const newRules: OptimizationRule[] = [];

    for (const dim of Object.keys(DIM_COLUMN)) {
      const col = DIM_COLUMN[dim]!;
      const rule = deriveRulesForDimension(this.db, dim, col, () => this.generateId());
      if (rule) {
        this.rules.set(rule.id, rule);
        newRules.push(rule);
      }
    }

    logger.info({ derived: newRules.length }, 'learnFromHistory complete');
    return newRules;
  }

  // ---------------------------------------------------------------------------
  // generateBlueprint
  // ---------------------------------------------------------------------------

  async generateBlueprint(topic: string): Promise<ContentBlueprint> {
    if (!topic?.trim()) throw new Error('topic is required');
    logger.info({ topic }, 'generateBlueprint called');

    // Capture each decide() return directly. Previously this used a
    // decisions[] array followed by 5 `.find(d => d.dimension === '...')!`
    // calls — the non-null assertions were sound (decide() always tags
    // its return with the input dimension) but encoded a brittle
    // rename-and-crash invariant. Direct assignment removes the assertions
    // while keeping the same call order and `decisions` array contents.
    const hookDec = await this.decide('hook_type',
      ['curiosity', 'shock', 'how-to', 'story', 'challenge', 'question']);
    const thumbDec = await this.decide('thumbnail_style',
      ['face-reaction', 'text-heavy', 'minimal', 'split-screen', 'collage']);
    const durDec = await this.decide('duration_bucket',
      ['short (<5m)', 'medium (5-10m)', 'long (10-20m)', 'deep-dive (>20m)']);
    const timeDec = await this.decide('posting_time',
      ['morning (6-9am)', 'midday (11am-1pm)', 'evening (5-8pm)', 'night (9pm+)']);
    const moodDec = await this.decide('music_mood',
      ['energetic', 'calm', 'suspenseful', 'uplifting', 'dark', 'neutral']);
    const decisions: ContentDecision[] = [hookDec, thumbDec, durDec, timeDec, moodDec];

    const durationMap: Record<string, number> = {
      'short (<5m)': 4, 'medium (5-10m)': 8,
      'long (10-20m)': 15, 'deep-dive (>20m)': 25,
    };

    // Expected performance: baseline × optimism factor
    const perfRow = this.db.prepare(`
      SELECT AVG(views) AS avg_views, AVG(ctr) AS avg_ctr, AVG(avg_view_percentage) AS avg_ret
      FROM video_performance WHERE views > 0
    `).get() as { avg_views: number; avg_ctr: number; avg_ret: number } | undefined;

    const expectedPerformance = {
      views: Math.round((perfRow?.avg_views ?? 0) * 1.15),
      ctr: Math.round(((perfRow?.avg_ctr ?? 0) * 1.1) * 10000) / 10000,
      retention: Math.round(((perfRow?.avg_ret ?? 0) * 1.05) * 100) / 100,
    };

    const blueprint: ContentBlueprint = {
      topic,
      hookType: hookDec.chosenValue,
      thumbnailStyle: thumbDec.chosenValue,
      targetDuration: durationMap[durDec.chosenValue] ?? 8,
      postingTime: timeDec.chosenValue,
      musicMood: moodDec.chosenValue,
      decisions,
      expectedPerformance,
    };

    const blueprintId = this.generateId();
    this.db.prepare(`
      INSERT INTO content_blueprints (id, topic, blueprint, expected_performance, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(blueprintId, topic, JSON.stringify(blueprint),
      JSON.stringify(expectedPerformance), new Date().toISOString());

    logger.info({ topic, blueprintId }, 'Blueprint generated and stored');
    return blueprint;
  }

  // ---------------------------------------------------------------------------
  // decide
  // ---------------------------------------------------------------------------

  async decide(dimension: string, options: string[]): Promise<ContentDecision> {
    if (!dimension?.trim()) throw new Error('dimension is required');
    if (!Array.isArray(options) || options.length === 0) {
      throw new Error('options must be a non-empty array');
    }

    logger.debug({ dimension, optionCount: options.length }, 'decide called');

    const activeRule = [...this.rules.values()]
      .find(r => r.active && r.dimension === dimension);

    let chosenValue = options[0]!;
    let reasoning = 'Default: no performance data; chose first option.';
    let confidence = 0.3;
    let basedOnVideos = 0;

    if (activeRule) {
      const match = activeRule.rule.match(/prefer [^=]+="([^"]+)"/);
      const preferred = match?.[1]?.trim();
      const hit = preferred && options.find(o => o === preferred);

      if (hit) {
        chosenValue = hit;
        reasoning = `Rule: ${activeRule.rule}. Evidence: ${activeRule.evidence}`;
        confidence = Math.min(0.95, 0.4 + activeRule.strength * 0.55);
        const nMatch = activeRule.evidence.match(/n=(\d+)/);
        basedOnVideos = nMatch ? parseInt(nMatch[1]!, 10) : 0;
      } else {
        reasoning = `Rule exists but preferred value not in provided options; defaulting.`;
        confidence = 0.35;
      }
    }

    const decision: ContentDecision = {
      id: this.generateId(), dimension,
      chosenValue, alternatives: options.filter(o => o !== chosenValue),
      reasoning, confidence, basedOnVideos,
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO content_decisions
        (id, dimension, chosen_value, alternatives, reasoning, confidence, based_on_videos, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(decision.id, decision.dimension, decision.chosenValue,
      JSON.stringify(decision.alternatives), decision.reasoning,
      decision.confidence, decision.basedOnVideos, decision.createdAt);

    logger.debug({ dimension, chosen: chosenValue, confidence }, 'Decision recorded');
    return decision;
  }

  // ---------------------------------------------------------------------------
  // getActiveRules
  // ---------------------------------------------------------------------------

  getActiveRules(): OptimizationRule[] {
    return [...this.rules.values()].filter(r => r.active);
  }

  // ---------------------------------------------------------------------------
  // disableRule / enableRule
  // ---------------------------------------------------------------------------

  disableRule(ruleId: string): void {
    if (!ruleId?.trim()) throw new Error('ruleId is required');
    if (!this.rules.has(ruleId)) {
      const row = this.db.prepare('SELECT * FROM optimization_rules WHERE id = ?')
        .get(ruleId) as RuleRow | undefined;
      if (!row) throw new Error(`Rule not found: ${ruleId}`);
      this.rules.set(ruleId, {
        id: row.id, dimension: row.dimension, rule: row.rule,
        evidence: row.evidence, strength: row.strength,
        active: false, createdAt: row.created_at,
      });
    } else {
      this.rules.get(ruleId)!.active = false;
    }
    this.db.prepare('UPDATE optimization_rules SET active = 0 WHERE id = ?').run(ruleId);
    logger.info({ ruleId }, 'Rule disabled');
  }

  enableRule(ruleId: string): void {
    if (!ruleId?.trim()) throw new Error('ruleId is required');
    if (!this.rules.has(ruleId)) {
      const row = this.db.prepare('SELECT * FROM optimization_rules WHERE id = ?')
        .get(ruleId) as RuleRow | undefined;
      if (!row) throw new Error(`Rule not found: ${ruleId}`);
      this.rules.set(ruleId, {
        id: row.id, dimension: row.dimension, rule: row.rule,
        evidence: row.evidence, strength: row.strength,
        active: true, createdAt: row.created_at,
      });
    } else {
      this.rules.get(ruleId)!.active = true;
    }
    this.db.prepare('UPDATE optimization_rules SET active = 1 WHERE id = ?').run(ruleId);
    logger.info({ ruleId }, 'Rule enabled');
  }

  // ---------------------------------------------------------------------------
  // recordOutcome
  // ---------------------------------------------------------------------------

  recordOutcome(decisionId: string, actualPerformance: Record<string, number>): void {
    if (!decisionId?.trim()) throw new Error('decisionId is required');
    if (!actualPerformance || typeof actualPerformance !== 'object') {
      throw new Error('actualPerformance must be a non-null object');
    }
    this.db.prepare('UPDATE content_decisions SET outcome = ? WHERE id = ?')
      .run(JSON.stringify(actualPerformance), decisionId);
    logger.info({ decisionId }, 'Outcome recorded');
  }

  // ---------------------------------------------------------------------------
  // getHistory
  // ---------------------------------------------------------------------------

  getHistory(limit = 20): ContentDecision[] {
    const safeLimit = Math.min(200, Math.max(1, limit));
    const rows = this.db.prepare(
      'SELECT * FROM content_decisions ORDER BY created_at DESC LIMIT ?',
    ).all(safeLimit) as DecisionRow[];
    return rows.map(r => ({
      id: r.id, dimension: r.dimension,
      chosenValue: r.chosen_value,
      alternatives: JSON.parse(r.alternatives || '[]') as string[],
      reasoning: r.reasoning, confidence: r.confidence,
      basedOnVideos: r.based_on_videos, createdAt: r.created_at,
    }));
  }

  // ---------------------------------------------------------------------------
  // getImprovementMetrics
  // ---------------------------------------------------------------------------

  getImprovementMetrics(): { beforeOptimization: number; afterOptimization: number; improvementPercent: number } {
    const metrics = queryImprovementMetrics(this.db);
    logger.info(metrics, 'Improvement metrics computed');
    return metrics;
  }
}
