/**
 * EarningTracker — pulls YouTube Analytics data and persists metrics.
 * Uses the YouTube Analytics API v2 with OAuth2 bearer token.
 */

import { createLogger } from '../shared/logger.js';
import { PipelineError } from '../shared/errors.js';
import { todayISO } from '../shared/utils.js';
import { MindDB } from '../memory/db.js';
import type {
  VideoMetrics,
  YouTubeAnalyticsResponse,
} from './types.js';

const log = createLogger('earning:tracker');

// ---------------------------------------------------------------------------
// Persistent SQLite store via MindDB.
// The video_metrics table is defined in schema.ts and created on first open.
// A single shared MindDB instance is used for the lifetime of the process.
// ---------------------------------------------------------------------------

let _sharedDb: MindDB | null = null;

function getDb(): MindDB {
  if (!_sharedDb) {
    _sharedDb = new MindDB('data/mind.db');
    log.info('EarningTracker: MindDB opened at data/mind.db');
  }
  return _sharedDb;
}

const YT_ANALYTICS_BASE = 'https://youtubeanalytics.googleapis.com/v2';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAccessToken(): string {
  const token = process.env['YOUTUBE_ACCESS_TOKEN'] ?? process.env['YOUTUBE_API_KEY'];
  if (!token) {
    throw new PipelineError(
      'YOUTUBE_ACCESS_TOKEN or YOUTUBE_API_KEY not set',
      'pipeline_earning_no_token',
    );
  }
  return token;
}

function buildAnalyticsUrl(
  videoId: string,
  startDate: string,
  endDate: string,
): string {
  const params = new URLSearchParams({
    ids: 'channel==MINE',
    startDate,
    endDate,
    metrics: 'views,estimatedMinutesWatched,subscribersGained,likes,estimatedRevenue,annotationClickThroughRate,averageViewDuration',
    dimensions: 'video',
    filters: `video==${videoId}`,
    sort: '-views',
    maxResults: '1',
  });
  return `${YT_ANALYTICS_BASE}/reports?${params.toString()}`;
}

function parseAnalyticsRow(
  row: (string | number)[],
  headers: string[],
  title: string,
  recordedAt: string,
): VideoMetrics {
  const get = (name: string): number => {
    const idx = headers.indexOf(name);
    return idx >= 0 ? Number(row[idx] ?? 0) : 0;
  };

  const youtubeId = String(row[headers.indexOf('video')] ?? '');

  return {
    youtubeId,
    title,
    views: get('views'),
    watchTimeHours: get('estimatedMinutesWatched') / 60,
    subscribersGained: get('subscribersGained'),
    likes: get('likes'),
    estimatedRevenue: get('estimatedRevenue'),
    ctr: get('annotationClickThroughRate'),
    avgViewDuration: get('averageViewDuration'),
    recordedAt,
  };
}

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

export class EarningTracker {
  /**
   * Pull analytics for a single YouTube video ID.
   * Stores the result in the in-memory metrics store.
   */
  async pullMetrics(youtubeId: string, title = ''): Promise<VideoMetrics> {
    if (!youtubeId || youtubeId.trim().length === 0) {
      throw new PipelineError(
        'youtubeId must be non-empty',
        'pipeline_earning_invalid_id',
      );
    }

    const token = getAccessToken();
    const endDate = todayISO();
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0] as string;

    log.debug({ youtubeId, startDate, endDate }, 'Pulling YouTube analytics');

    const url = buildAnalyticsUrl(youtubeId, startDate, endDate);
    let metrics: VideoMetrics;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new PipelineError(
          `YouTube Analytics API error: ${response.status} ${body.slice(0, 200)}`,
          'pipeline_earning_api_error',
          { status: response.status, youtubeId },
        );
      }

      const data = (await response.json()) as YouTubeAnalyticsResponse;
      const headers = data.columnHeaders.map((h) => h.name);
      const row = data.rows?.[0] as unknown as (string | number)[] | undefined;

      if (!row) {
        log.warn({ youtubeId }, 'No analytics data returned for video — returning zeros');
        metrics = {
          youtubeId,
          title,
          views: 0,
          watchTimeHours: 0,
          subscribersGained: 0,
          likes: 0,
          estimatedRevenue: 0,
          ctr: 0,
          avgViewDuration: 0,
          recordedAt: todayISO(),
        };
      } else {
        metrics = parseAnalyticsRow(row, headers, title, todayISO());
        metrics.title = title || metrics.title;
      }
    } catch (err) {
      if (err instanceof PipelineError) throw err;
      throw new PipelineError(
        `Failed to pull metrics for ${youtubeId}: ${String(err)}`,
        'pipeline_earning_fetch_error',
      );
    }

    const db = getDb();
    db.storeVideoMetrics({
      video_id:         metrics.youtubeId,
      channel:          'default',
      title:            metrics.title,
      views:            metrics.views,
      likes:            metrics.likes,
      comments:         0,
      watch_time_hours: metrics.watchTimeHours,
      ctr:              metrics.ctr,
      avg_view_pct:     0,
      revenue_usd:      metrics.estimatedRevenue,
    });

    log.info(
      { youtubeId, views: metrics.views, revenue: metrics.estimatedRevenue },
      'Metrics pulled and stored to SQLite',
    );

    return metrics;
  }

  /**
   * Pull analytics for all known video IDs in the store.
   * Returns a map of youtubeId → latest VideoMetrics.
   */
  async pullAllMetrics(): Promise<Map<string, VideoMetrics>> {
    const db = getDb();
    // Retrieve all distinct video IDs stored in SQLite.
    const rows = db.db
      .prepare<[], { video_id: string }>('SELECT DISTINCT video_id FROM video_metrics')
      .all();

    log.info({ videoCount: rows.length }, 'Pulling all video metrics');
    const results = new Map<string, VideoMetrics>();

    for (const { video_id } of rows) {
      try {
        const m = await this.pullMetrics(video_id);
        results.set(video_id, m);
      } catch (err) {
        log.error({ youtubeId: video_id, err: String(err) }, 'Failed to pull metrics for video');
      }
    }

    return results;
  }

  /**
   * Aggregate revenue for a given period (ISO date string or 'all').
   */
  getRevenue(period: string): number {
    const db = getDb();
    let total: number;

    if (period === 'all') {
      // Sum only the latest snapshot per video_id — revenue_usd is cumulative
      // per video, so summing every historical snapshot would multiply the
      // total by the number of pulls (mirrors getTopVideos de-dup).
      const row = db.db
        .prepare<[], { total: number }>(
          'SELECT COALESCE(SUM(revenue_usd), 0) AS total FROM video_metrics WHERE id IN (SELECT MAX(id) FROM video_metrics GROUP BY video_id)',
        )
        .get();
      total = row?.total ?? 0;
    } else {
      // period is an ISO prefix like "2026-03" or "2026-03-27".
      // De-dup to the latest snapshot per video_id within the period so that
      // multiple snapshots in the same period are not double-counted.
      const row = db.db
        .prepare<{ prefix: string }, { total: number }>(
          "SELECT COALESCE(SUM(revenue_usd), 0) AS total FROM video_metrics WHERE id IN (SELECT MAX(id) FROM video_metrics WHERE snapshot_at LIKE :prefix || '%' GROUP BY video_id)",
        )
        .get({ prefix: period });
      total = row?.total ?? 0;
    }

    log.debug({ period, totalRevenue: total }, 'Revenue calculated from SQLite');
    return total;
  }

  /**
   * Return the top N videos by views — one (latest) snapshot per video.
   */
  getTopVideos(limit = 10): VideoMetrics[] {
    if (limit < 1) {
      throw new PipelineError('limit must be >= 1', 'pipeline_earning_invalid_limit');
    }

    const db = getDb();
    // For each video_id take the snapshot with the highest id (most recent write).
    const rows = db.db
      .prepare<{ limit: number }, {
        video_id: string;
        title: string | null;
        views: number;
        watch_time_hours: number;
        likes: number;
        revenue_usd: number;
        ctr: number;
        snapshot_at: string;
      }>(`
        SELECT video_id, title, views, watch_time_hours, likes, revenue_usd, ctr, snapshot_at
        FROM video_metrics
        WHERE id IN (SELECT MAX(id) FROM video_metrics GROUP BY video_id)
        ORDER BY views DESC
        LIMIT :limit
      `)
      .all({ limit });

    const result: VideoMetrics[] = rows.map((r) => ({
      youtubeId:         r.video_id,
      title:             r.title ?? '',
      views:             r.views,
      watchTimeHours:    r.watch_time_hours,
      subscribersGained: 0,
      likes:             r.likes,
      estimatedRevenue:  r.revenue_usd,
      ctr:               r.ctr,
      avgViewDuration:   0,
      recordedAt:        r.snapshot_at.split('T')[0] ?? r.snapshot_at,
    }));

    log.debug({ limit, resultCount: result.length }, 'Top videos fetched from SQLite');
    return result;
  }
}
