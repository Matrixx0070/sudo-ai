/**
 * youtube-api.ts — HTTP calls to YouTube APIs and pure pattern-analysis helpers.
 *
 * Isolated from the main YouTubeAnalytics class so each file stays under 300 lines.
 * Network functions have no DB side-effects; analysis functions are purely functional.
 */

import { createLogger } from '../shared/logger.js';
import type { VideoPerformance, PerformanceInsight } from './youtube-analytics.js';

const logger = createLogger('youtube-api');

const YT_DATA_BASE = 'https://www.googleapis.com/youtube/v3';
const YT_ANALYTICS_BASE = 'https://youtubeanalytics.googleapis.com/v2';

// ---------------------------------------------------------------------------
// Internal response types
// ---------------------------------------------------------------------------

interface YTVideoItem {
  id: string;
  snippet?: { title?: string; publishedAt?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
}

interface YTVideosResponse {
  items?: YTVideoItem[];
}

interface YTSearchResponse {
  items?: Array<{ id?: { videoId?: string } }>;
  nextPageToken?: string;
}

interface YTAnalyticsResponse {
  columnHeaders?: Array<{ name: string }>;
  rows?: Array<Array<string | number>>;
  error?: { message: string };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Parse ISO 8601 duration (PT1M30S) to total seconds. */
export function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] ?? '0', 10) * 3600) +
         (parseInt(m[2] ?? '0', 10) * 60) +
         parseInt(m[3] ?? '0', 10);
}

async function fetchJson<T>(url: string, label: string, headers?: Record<string, string>): Promise<T> {
  logger.debug({ url, label }, 'HTTP GET');
  const res = await fetch(url, headers ? { headers } : undefined);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/** Fetch all video IDs for a channel (up to 200). */
export async function listChannelVideoIds(channelId: string, apiKey: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = '';
  do {
    const pt = pageToken ? `&pageToken=${pageToken}` : '';
    const url = `${YT_DATA_BASE}/search?part=id&channelId=${channelId}&type=video&maxResults=50&order=date${pt}&key=${apiKey}`;
    const data = await fetchJson<YTSearchResponse>(url, 'search.list');
    for (const item of data.items ?? []) {
      if (item.id?.videoId) ids.push(item.id.videoId);
    }
    pageToken = data.nextPageToken ?? '';
  } while (pageToken && ids.length < 200);
  return ids;
}

/** Fetch basic stats for a batch of video IDs (max 50 per call). */
export async function fetchVideoStats(
  videoIds: string[],
  apiKey: string,
): Promise<VideoPerformance[]> {
  const results: VideoPerformance[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50).join(',');
    const url = `${YT_DATA_BASE}/videos?part=snippet,statistics,contentDetails&id=${batch}&key=${apiKey}`;
    const data = await fetchJson<YTVideosResponse>(url, 'videos.list');
    for (const item of data.items ?? []) {
      results.push({
        videoId: item.id,
        title: item.snippet?.title ?? 'Unknown',
        publishedAt: item.snippet?.publishedAt ?? '',
        views: parseInt(item.statistics?.viewCount ?? '0', 10),
        likes: parseInt(item.statistics?.likeCount ?? '0', 10),
        comments: parseInt(item.statistics?.commentCount ?? '0', 10),
        estimatedMinutesWatched: 0,
        averageViewDuration: 0,
        averageViewPercentage: 0,
        clickThroughRate: 0,
        impressions: 0,
        subscribersGained: 0,
        duration: parseDuration(item.contentDetails?.duration ?? ''),
      });
    }
  }
  return results;
}

/** Enrich VideoPerformance records with CTR / retention data from Analytics API. */
export async function enrichWithAnalytics(
  videos: VideoPerformance[],
  channelId: string,
  oauthToken: string,
): Promise<void> {
  const ids = videos.map(v => v.videoId).join(',');
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const metrics = 'estimatedMinutesWatched,averageViewDuration,averageViewPercentage,cardClickRate';
  const url =
    `${YT_ANALYTICS_BASE}/reports?ids=channel==${channelId}` +
    `&startDate=${start}&endDate=${end}` +
    `&metrics=${metrics}&dimensions=video&filters=video==${ids}`;

  let data: YTAnalyticsResponse;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${oauthToken}` } });
    data = await res.json() as YTAnalyticsResponse;
  } catch (err) {
    logger.warn({ err: String(err) }, 'Analytics API call failed — skipping enrichment');
    return;
  }

  if (data.error) {
    logger.warn({ msg: data.error.message }, 'Analytics API error — skipping enrichment');
    return;
  }

  const headers = (data.columnHeaders ?? []).map(h => h.name);
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  for (const row of data.rows ?? []) {
    const vid = videos.find(v => v.videoId === String(row[idx['video'] ?? 0]));
    if (!vid) continue;
    vid.estimatedMinutesWatched = Number(row[idx['estimatedMinutesWatched'] ?? -1] ?? 0);
    vid.averageViewDuration = Number(row[idx['averageViewDuration'] ?? -1] ?? 0);
    vid.averageViewPercentage = Number(row[idx['averageViewPercentage'] ?? -1] ?? 0);
    vid.clickThroughRate = Number(row[idx['cardClickRate'] ?? -1] ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Pure pattern-analysis helpers (no DB, no network)
// ---------------------------------------------------------------------------

type AnalysisRow = Record<string, unknown>;

/** Analyse a single grouping dimension and return the top insight (if significant). */
export function analyzeByDimension(
  rows: AnalysisRow[], dim: string, metric: string, metricLabel: string, category: string,
): PerformanceInsight[] {
  const groups: Record<string, number[]> = {};
  for (const r of rows) {
    const key = String(r[dim] ?? 'unknown');
    const val = Number(r[metric] ?? 0);
    if (!groups[key]) groups[key] = [];
    groups[key]!.push(val);
  }
  const averages = Object.entries(groups)
    .filter(([, v]) => v.length >= 2)
    .map(([key, v]) => ({ key, avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }))
    .sort((a, b) => b.avg - a.avg);

  if (averages.length < 2) return [];
  const best = averages[0]!;
  const worst = averages[averages.length - 1]!;
  if (worst.avg === 0) return [];
  const ratio = best.avg / worst.avg;
  const confidence = Math.min(0.95, 0.5 + (Math.min(best.n, 10) - 2) * 0.05);
  return [{
    pattern: `"${best.key}" ${dim.replace('_', ' ')} achieves ${(best.avg * 100).toFixed(1)}% ${metricLabel} vs ${(worst.avg * 100).toFixed(1)}% for "${worst.key}" (${ratio.toFixed(1)}x difference)`,
    confidence,
    actionable: `Prefer "${best.key}" ${dim.replace('_', ' ')} — outperforms "${worst.key}" by ${ratio.toFixed(1)}x on ${metricLabel}`,
    basedOn: averages.reduce((s, a) => s + a.n, 0),
    category,
  }];
}

/** Bucket videos by duration and find the highest-retention bucket. */
export function analyzeDurationBuckets(rows: AnalysisRow[]): PerformanceInsight[] {
  const buckets: Record<string, number[]> = { 'under-30s': [], '30-60s': [], '1-3min': [], 'over-3min': [] };
  for (const r of rows) {
    const d = Number(r['duration_seconds'] ?? 0);
    const pct = Number(r['avg_view_percentage'] ?? 0);
    const b = d < 30 ? 'under-30s' : d < 60 ? '30-60s' : d < 180 ? '1-3min' : 'over-3min';
    buckets[b]!.push(pct);
  }
  const summary = Object.entries(buckets)
    .filter(([, v]) => v.length >= 2)
    .map(([label, v]) => ({ label, avgPct: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }))
    .sort((a, b) => b.avgPct - a.avgPct);
  if (summary.length < 2) return [];
  const best = summary[0]!;
  return [{
    pattern: `Duration bucket "${best.label}" achieves highest avg view retention (${(best.avgPct * 100).toFixed(1)}%)`,
    confidence: Math.min(0.9, 0.4 + best.n * 0.05),
    actionable: `Target "${best.label}" video length for maximum viewer retention`,
    basedOn: summary.reduce((s, b) => s + b.n, 0),
    category: 'duration',
  }];
}

/** Find the UTC posting hour with the highest average views. */
export function analyzePostingTimes(rows: AnalysisRow[]): PerformanceInsight[] {
  const hours: Record<number, number[]> = {};
  for (const r of rows) {
    const pub = String(r['published_at'] ?? '');
    if (!pub) continue;
    const h = new Date(pub).getUTCHours();
    if (!hours[h]) hours[h] = [];
    hours[h]!.push(Number(r['views'] ?? 0));
  }
  const ranked = Object.entries(hours)
    .filter(([, v]) => v.length >= 2)
    .map(([h, v]) => ({ hour: Number(h), avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }))
    .sort((a, b) => b.avg - a.avg);
  if (ranked.length < 2) return [];
  const best = ranked[0]!;
  return [{
    pattern: `Videos posted at ${best.hour}:00 UTC average ${Math.round(best.avg)} views (highest among ${ranked.length} posting-hour buckets)`,
    confidence: Math.min(0.85, 0.4 + best.n * 0.05),
    actionable: `Schedule uploads around ${best.hour}:00 UTC for highest view potential`,
    basedOn: ranked.reduce((s, r) => s + r.n, 0),
    category: 'timing',
  }];
}
