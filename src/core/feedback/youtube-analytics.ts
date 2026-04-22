/**
 * YouTube Analytics Feedback Loop
 *
 * Pulls video performance data and correlates with production decisions.
 * Stores results in mind.db for pattern learning.
 *
 * Requires YOUTUBE_API_KEY in .env (YouTube Data API v3).
 * For CTR/impression data, YOUTUBE_OAUTH_TOKEN is also needed
 * (YouTube Analytics API v2 requires OAuth 2.0).
 *
 * If no API key is present the module operates in read-only mode
 * against previously stored data.
 *
 * Raw HTTP calls are delegated to youtube-api.ts to keep this file
 * focused on storage and pattern analysis.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  listChannelVideoIds, fetchVideoStats, enrichWithAnalytics,
  analyzeByDimension, analyzeDurationBuckets, analyzePostingTimes,
} from './youtube-api.js';

const logger = createLogger('youtube-analytics');

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface VideoPerformance {
  videoId: string;
  title: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  averageViewPercentage: number;
  clickThroughRate: number;
  impressions: number;
  subscribersGained: number;
  hookType?: string;
  thumbnailStyle?: string;
  topic?: string;
  duration?: number;
}

export interface PerformanceInsight {
  pattern: string;
  confidence: number;
  actionable: string;
  basedOn: number;
  category: string;
}

// ---------------------------------------------------------------------------
// YouTubeAnalytics class
// ---------------------------------------------------------------------------

export class YouTubeAnalytics {
  private db: Database.Database;

  constructor(
    private readonly apiKey: string,
    private readonly channelId: string,
    private readonly dbPath: string,
  ) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    logger.info({ channelId, dbPath }, 'YouTubeAnalytics initialised');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS video_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        title TEXT NOT NULL,
        published_at TEXT,
        views INTEGER DEFAULT 0,
        likes INTEGER DEFAULT 0,
        comments INTEGER DEFAULT 0,
        watch_time_minutes REAL DEFAULT 0,
        avg_view_duration REAL DEFAULT 0,
        avg_view_percentage REAL DEFAULT 0,
        ctr REAL DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        subs_gained INTEGER DEFAULT 0,
        hook_type TEXT,
        thumbnail_style TEXT,
        topic TEXT,
        duration_seconds INTEGER,
        fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(video_id, fetched_at)
      );

      CREATE TABLE IF NOT EXISTS performance_insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL,
        confidence REAL NOT NULL,
        actionable TEXT NOT NULL,
        based_on INTEGER DEFAULT 0,
        category TEXT DEFAULT 'general',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    logger.debug('Schema initialised');
  }

  // --------------------------------------------------------------------------
  // fetchPerformance
  // --------------------------------------------------------------------------

  async fetchPerformance(videoId?: string): Promise<VideoPerformance[]> {
    if (!this.apiKey) {
      logger.warn('No YOUTUBE_API_KEY — returning stored data only');
      return this.loadStoredPerformance(videoId);
    }

    const videoIds = videoId
      ? [videoId]
      : await listChannelVideoIds(this.channelId, this.apiKey);

    if (videoIds.length === 0) {
      logger.info('No videos found for channel');
      return [];
    }

    logger.info({ count: videoIds.length }, 'Fetching video stats from Data API');
    const results = await fetchVideoStats(videoIds, this.apiKey);

    const oauthToken = process.env['YOUTUBE_OAUTH_TOKEN'];
    if (oauthToken) {
      await enrichWithAnalytics(results, this.channelId, oauthToken);
    } else {
      logger.info('No YOUTUBE_OAUTH_TOKEN — skipping CTR/impressions enrichment');
    }

    logger.info({ fetched: results.length }, 'fetchPerformance complete');
    return results;
  }

  // --------------------------------------------------------------------------
  // storePerformance
  // --------------------------------------------------------------------------

  async storePerformance(data: VideoPerformance[]): Promise<void> {
    if (!Array.isArray(data) || data.length === 0) {
      logger.warn('storePerformance: empty data array, nothing stored');
      return;
    }

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO video_performance
        (video_id, title, published_at, views, likes, comments,
         watch_time_minutes, avg_view_duration, avg_view_percentage,
         ctr, impressions, subs_gained, hook_type, thumbnail_style,
         topic, duration_seconds)
      VALUES
        (@videoId, @title, @publishedAt, @views, @likes, @comments,
         @watchTime, @avgDur, @avgPct,
         @ctr, @impressions, @subsGained, @hookType, @thumbnailStyle,
         @topic, @duration)
    `);

    const insertMany = this.db.transaction((rows: VideoPerformance[]) => {
      for (const r of rows) {
        stmt.run({
          videoId: r.videoId,  title: r.title,
          publishedAt: r.publishedAt, views: r.views,
          likes: r.likes, comments: r.comments,
          watchTime: r.estimatedMinutesWatched, avgDur: r.averageViewDuration,
          avgPct: r.averageViewPercentage, ctr: r.clickThroughRate,
          impressions: r.impressions, subsGained: r.subscribersGained,
          hookType: r.hookType ?? null, thumbnailStyle: r.thumbnailStyle ?? null,
          topic: r.topic ?? null, duration: r.duration ?? null,
        });
      }
    });

    insertMany(data);
    logger.info({ stored: data.length }, 'storePerformance complete');
  }

  // -- analyzePatterns --------------------------------------------------------

  async analyzePatterns(): Promise<PerformanceInsight[]> {
    const rows = this.db.prepare(`
      SELECT video_id, hook_type, thumbnail_style, topic, duration_seconds,
             ctr, avg_view_percentage, watch_time_minutes, views, published_at
      FROM video_performance WHERE views > 0 ORDER BY published_at DESC
    `).all() as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      logger.info('analyzePatterns: no data available yet');
      return [];
    }

    const insights: PerformanceInsight[] = [
      ...analyzeByDimension(rows, 'hook_type', 'ctr', 'click-through rate', 'hook'),
      ...analyzeByDimension(rows, 'thumbnail_style', 'ctr', 'click-through rate', 'thumbnail'),
      ...analyzeByDimension(rows, 'topic', 'avg_view_percentage', 'view retention', 'topic'),
      ...analyzeDurationBuckets(rows),
      ...analyzePostingTimes(rows),
    ];

    logger.info({ insights: insights.length }, 'analyzePatterns complete');
    return insights;
  }

  // -- getTopPerformers / getBottomPerformers ---------------------------------

  async getTopPerformers(metric: string, limit = 5): Promise<VideoPerformance[]> {
    return this.queryPerformers(this.safeMetricColumn(metric), 'DESC', limit);
  }

  async getBottomPerformers(metric: string, limit = 5): Promise<VideoPerformance[]> {
    return this.queryPerformers(this.safeMetricColumn(metric), 'ASC', limit);
  }

  private safeMetricColumn(metric: string): string {
    const allowed: Record<string, string> = {
      views: 'views', likes: 'likes', comments: 'comments',
      ctr: 'ctr', impressions: 'impressions', watch_time: 'watch_time_minutes',
      retention: 'avg_view_percentage', subs: 'subs_gained',
    };
    const col = allowed[metric];
    if (!col) throw new Error(`Unknown metric "${metric}". Allowed: ${Object.keys(allowed).join(', ')}`);
    return col;
  }

  private queryPerformers(col: string, order: 'ASC' | 'DESC', limit: number): VideoPerformance[] {
    return (this.db.prepare(
      `SELECT * FROM video_performance ORDER BY ${col} ${order} LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>).map(r => this.rowToPerformance(r));
  }

  private rowToPerformance(r: Record<string, unknown>): VideoPerformance {
    return {
      videoId: String(r['video_id'] ?? ''), title: String(r['title'] ?? ''),
      publishedAt: String(r['published_at'] ?? ''),
      views: Number(r['views'] ?? 0), likes: Number(r['likes'] ?? 0),
      comments: Number(r['comments'] ?? 0),
      estimatedMinutesWatched: Number(r['watch_time_minutes'] ?? 0),
      averageViewDuration: Number(r['avg_view_duration'] ?? 0),
      averageViewPercentage: Number(r['avg_view_percentage'] ?? 0),
      clickThroughRate: Number(r['ctr'] ?? 0),
      impressions: Number(r['impressions'] ?? 0),
      subscribersGained: Number(r['subs_gained'] ?? 0),
      hookType: r['hook_type'] != null ? String(r['hook_type']) : undefined,
      thumbnailStyle: r['thumbnail_style'] != null ? String(r['thumbnail_style']) : undefined,
      topic: r['topic'] != null ? String(r['topic']) : undefined,
      duration: r['duration_seconds'] != null ? Number(r['duration_seconds']) : undefined,
    };
  }

  private loadStoredPerformance(videoId?: string): VideoPerformance[] {
    const rows = (videoId
      ? this.db.prepare('SELECT * FROM video_performance WHERE video_id = ? ORDER BY fetched_at DESC').all(videoId)
      : this.db.prepare('SELECT * FROM video_performance ORDER BY fetched_at DESC').all()
    ) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToPerformance(r));
  }

  // -- generateReport ---------------------------------------------------------

  async generateReport(): Promise<string> {
    const insights = await this.analyzePatterns();
    const { n } = this.db.prepare('SELECT COUNT(*) as n FROM video_performance').get() as { n: number };
    const topViews = await this.getTopPerformers('views', 3);
    const topCtr = await this.getTopPerformers('ctr', 3);

    const lines: string[] = [
      `=== YouTube Performance Report ===`,
      `Generated: ${new Date().toISOString()}`,
      `Total video records: ${n}`,
      '', '--- Top Videos by Views ---',
      ...topViews.map((v, i) => `  ${i + 1}. "${v.title}" — ${v.views.toLocaleString()} views`),
      '', '--- Top Videos by CTR ---',
      ...topCtr.map((v, i) => `  ${i + 1}. "${v.title}" — ${(v.clickThroughRate * 100).toFixed(2)}% CTR`),
      '', '--- Insights ---',
      ...(insights.length > 0
        ? insights.map(ins =>
            `  [${ins.category.toUpperCase()} | conf:${(ins.confidence * 100).toFixed(0)}% | n=${ins.basedOn}]\n` +
            `  Pattern:    ${ins.pattern}\n` +
            `  Actionable: ${ins.actionable}`)
        : ['  Not enough data yet — fetch and store more videos to generate insights.']),
    ];

    return lines.join('\n');
  }
}
