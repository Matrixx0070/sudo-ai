/**
 * Learning Engine — extracts patterns from YouTube analytics
 * and applies learnings to future content production.
 *
 * Works with the video_performance and performance_insights tables
 * in mind.db. Operates independently of the Analytics API — only
 * needs stored rows to derive correlations.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { PerformanceInsight } from './youtube-analytics.js';

const logger = createLogger('learning-engine');

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PerformanceRow {
  video_id: string;
  title: string;
  views: number;
  likes: number;
  ctr: number;
  avg_view_percentage: number;
  watch_time_minutes: number;
  impressions: number;
  subs_gained: number;
  hook_type: string | null;
  thumbnail_style: string | null;
  topic: string | null;
  duration_seconds: number | null;
  published_at: string | null;
}

interface GroupStat {
  key: string;
  count: number;
  avgCtr: number;
  avgRetention: number;
  avgViews: number;
  avgWatchTime: number;
  avgSubs: number;
}

interface Recommendation {
  category: string;
  insight: string;
  confidence: number;
  basedOn: number;
}

// ---------------------------------------------------------------------------
// LearningEngine class
// ---------------------------------------------------------------------------

export class LearningEngine {
  private db: Database.Database;

  constructor(private readonly dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    logger.info({ dbPath }, 'LearningEngine initialised');
  }

  // --------------------------------------------------------------------------
  // extractPatterns
  // --------------------------------------------------------------------------

  extractPatterns(): Map<string, GroupStat[]> {
    const rows = this.db.prepare(`
      SELECT video_id, title, views, likes, ctr, avg_view_percentage,
             watch_time_minutes, impressions, subs_gained,
             hook_type, thumbnail_style, topic, duration_seconds, published_at
      FROM video_performance
      WHERE views > 0
      ORDER BY published_at DESC
    `).all() as PerformanceRow[];

    if (rows.length === 0) {
      logger.info('extractPatterns: no rows available');
      return new Map();
    }

    logger.info({ rows: rows.length }, 'Extracting patterns');
    const patterns = new Map<string, GroupStat[]>();
    patterns.set('hook_type', this.groupBy(rows, 'hook_type'));
    patterns.set('thumbnail_style', this.groupBy(rows, 'thumbnail_style'));
    patterns.set('topic', this.groupBy(rows, 'topic'));
    patterns.set('duration_bucket', this.groupByDuration(rows));
    patterns.set('posting_hour', this.groupByHour(rows));
    return patterns;
  }

  private groupBy(rows: PerformanceRow[], dim: keyof PerformanceRow): GroupStat[] {
    const map: Record<string, PerformanceRow[]> = {};
    for (const r of rows) {
      const key = String(r[dim] ?? 'untagged');
      if (!map[key]) map[key] = [];
      map[key].push(r);
    }

    return Object.entries(map)
      .filter(([, group]) => group.length >= 2)
      .map(([key, group]) => this.calcStats(key, group))
      .sort((a, b) => b.avgCtr - a.avgCtr);
  }

  private groupByDuration(rows: PerformanceRow[]): GroupStat[] {
    const map: Record<string, PerformanceRow[]> = {};
    for (const r of rows) {
      const d = r.duration_seconds ?? 0;
      let bucket: string;
      if (d > 0 && d < 30) bucket = 'under-30s';
      else if (d < 60) bucket = '30-60s';
      else if (d < 180) bucket = '1-3min';
      else if (d < 600) bucket = '3-10min';
      else bucket = 'over-10min';
      if (!map[bucket]) map[bucket] = [];
      map[bucket].push(r);
    }

    return Object.entries(map)
      .filter(([, group]) => group.length >= 2)
      .map(([key, group]) => this.calcStats(key, group))
      .sort((a, b) => b.avgRetention - a.avgRetention);
  }

  private groupByHour(rows: PerformanceRow[]): GroupStat[] {
    const map: Record<string, PerformanceRow[]> = {};
    for (const r of rows) {
      if (!r.published_at) continue;
      const h = new Date(r.published_at).getUTCHours();
      const bucket = `${h.toString().padStart(2, '0')}:00 UTC`;
      if (!map[bucket]) map[bucket] = [];
      map[bucket].push(r);
    }

    return Object.entries(map)
      .filter(([, group]) => group.length >= 2)
      .map(([key, group]) => this.calcStats(key, group))
      .sort((a, b) => b.avgViews - a.avgViews);
  }

  private calcStats(key: string, group: PerformanceRow[]): GroupStat {
    const avg = (fn: (r: PerformanceRow) => number) =>
      group.reduce((s, r) => s + fn(r), 0) / group.length;
    return {
      key,
      count: group.length,
      avgCtr: avg(r => r.ctr),
      avgRetention: avg(r => r.avg_view_percentage),
      avgViews: avg(r => r.views),
      avgWatchTime: avg(r => r.watch_time_minutes),
      avgSubs: avg(r => r.subs_gained),
    };
  }

  // --------------------------------------------------------------------------
  // generateRecommendations
  // --------------------------------------------------------------------------

  generateRecommendations(): Recommendation[] {
    const patterns = this.extractPatterns();
    const recs: Recommendation[] = [];

    for (const [dim, stats] of patterns) {
      if (stats.length < 2) continue;

      const best = stats[0]!;
      const worst = stats[stats.length - 1]!;
      const totalN = stats.reduce((s, g) => s + g.count, 0);
      const confidence = Math.min(0.95, 0.45 + Math.min(totalN, 20) * 0.025);

      let metric: string;
      let bestVal: number;
      let worstVal: number;

      if (dim === 'hook_type' || dim === 'thumbnail_style') {
        metric = 'CTR';
        bestVal = best.avgCtr;
        worstVal = worst.avgCtr;
      } else if (dim === 'topic') {
        metric = 'retention';
        bestVal = best.avgRetention;
        worstVal = worst.avgRetention;
      } else if (dim === 'duration_bucket') {
        metric = 'retention';
        bestVal = best.avgRetention;
        worstVal = worst.avgRetention;
      } else {
        metric = 'views';
        bestVal = best.avgViews;
        worstVal = worst.avgViews;
      }

      if (worstVal <= 0 || bestVal <= worstVal) continue;
      const ratio = bestVal / worstVal;
      const pctGain = ((ratio - 1) * 100).toFixed(0);

      recs.push({
        category: dim.replace('_', '-'),
        insight: `"${best.key}" ${dim.replace('_', ' ')} yields ${ratio.toFixed(1)}x higher ${metric} than "${worst.key}" (${pctGain}% gain, n=${totalN})`,
        confidence,
        basedOn: totalN,
      });
    }

    logger.info({ recommendations: recs.length }, 'generateRecommendations complete');
    return recs;
  }

  // --------------------------------------------------------------------------
  // storeInsights
  // --------------------------------------------------------------------------

  storeInsights(insights: PerformanceInsight[]): void {
    if (insights.length === 0) {
      logger.warn('storeInsights: empty insights array');
      return;
    }

    const stmt = this.db.prepare(`
      INSERT INTO performance_insights (pattern, confidence, actionable, based_on, category)
      VALUES (@pattern, @confidence, @actionable, @basedOn, @category)
    `);

    const insertAll = this.db.transaction((rows: PerformanceInsight[]) => {
      for (const ins of rows) {
        stmt.run({
          pattern: ins.pattern,
          confidence: Math.max(0, Math.min(1, ins.confidence)),
          actionable: ins.actionable,
          basedOn: ins.basedOn,
          category: ins.category ?? 'general',
        });
      }
    });

    insertAll(insights);
    logger.info({ stored: insights.length }, 'storeInsights complete');
  }

  // --------------------------------------------------------------------------
  // getStoredInsights
  // --------------------------------------------------------------------------

  getStoredInsights(limit = 20, category?: string): PerformanceInsight[] {
    if (category) {
      return this.db.prepare(`
        SELECT pattern, confidence, actionable, based_on, category
        FROM performance_insights
        WHERE category = ?
        ORDER BY confidence DESC, created_at DESC
        LIMIT ?
      `).all(category, limit) as PerformanceInsight[];
    }
    return this.db.prepare(`
      SELECT pattern, confidence, actionable, based_on, category
      FROM performance_insights
      ORDER BY confidence DESC, created_at DESC
      LIMIT ?
    `).all(limit) as PerformanceInsight[];
  }

  // --------------------------------------------------------------------------
  // formatRecommendationsSummary
  // --------------------------------------------------------------------------

  formatRecommendationsSummary(): string {
    const recs = this.generateRecommendations();
    if (recs.length === 0) return 'No actionable recommendations yet — more video data needed.';

    const lines = [
      `=== Content Learning Recommendations ===`,
      `Based on ${recs.reduce((s, r) => s + r.basedOn, 0)} video records`,
      '',
    ];

    for (const rec of recs.sort((a, b) => b.confidence - a.confidence)) {
      lines.push(`[${rec.category.toUpperCase()} | ${(rec.confidence * 100).toFixed(0)}% confidence]`);
      lines.push(`  ${rec.insight}`);
      lines.push('');
    }

    return lines.join('\n').trimEnd();
  }
}
