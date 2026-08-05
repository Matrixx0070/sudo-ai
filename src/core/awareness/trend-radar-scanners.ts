/**
 * TrendRadar source scanners.
 *
 * Each scanner fetches data from a single external source and returns
 * an array of unnormalised TrendItem records (matchesNiche = false).
 * The caller (TrendRadar) applies niche-matching after all scanners return.
 *
 * Sources:
 *   - Hacker News   — Firebase REST JSON API
 *   - Reddit        — Public .json endpoint on subreddit hot listings
 *   - Google Trends — Daily trending RSS feed (US geo)
 *   - YouTube       — Data API v3 `videos.list?chart=mostPopular` (1 quota unit)
 *   - X / Twitter   — API v2 trends by WOEID (PAID, credential-gated, off by default)
 *
 * ## Why TikTok is absent (checked 2026-08-01, not assumed)
 *
 * There is no viable route. TikTok's official API exposes **no** trending-video,
 * hashtag-analytics or discovery endpoints at all. The Research API that could
 * approximate it is approval-gated (~4 weeks), restricted to accredited
 * researchers and nonprofits with commercial applications typically rejected,
 * capped at 1,000 requests/day, and **contractually prohibits commercial use of
 * the data** — which is exactly what a monetised channel is. Third-party
 * scraping vendors exist but are paid, ToS-grey and brittle.
 *
 * A TikTok scanner here would therefore have to either scrape (fragile, against
 * ToS) or ask a model to guess what is trending. The second is the failure mode
 * this codebase has already been burned by twice — see GAP-04a (fabricated CTR)
 * and GAP-15 (fabricated competitor alerts). No source is better than an
 * invented one. If TikTok signal is genuinely needed, it is a paid-vendor
 * procurement decision, not an engineering task.
 */

import { createLogger } from '../shared/logger.js';
import type { TrendItem } from './trend-radar-types.js';

const logger = createLogger('trend-radar-scanners');

const HTTP_TIMEOUT_MS = 10_000;
const HN_TOP_STORIES_URL = 'https://hacker-news.firebaseio.com/v0/topstories.json';
const HN_ITEM_URL = 'https://hacker-news.firebaseio.com/v0/item';
const GOOGLE_TRENDS_RSS = 'https://trends.google.com/trending/rss?geo=US';

export const DEFAULT_SUBREDDITS: readonly string[] = [
  'technology', 'artificial', 'MachineLearning', 'india',
  'pakistan', 'youtube', 'programming', 'startups',
];

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpJson<T>(url: string): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'SUDO-AI/4.0 TrendRadar (research bot)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function httpText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'SUDO-AI/4.0 TrendRadar (research bot)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Hacker News
// ---------------------------------------------------------------------------

/**
 * Fetch the top 30 HN stories. matchesNiche is always false — set by caller.
 */
export async function scanHackerNews(): Promise<TrendItem[]> {
  logger.debug('Scanning Hacker News');
  const ids = await httpJson<number[]>(HN_TOP_STORIES_URL);
  const top30 = ids.slice(0, 30);

  const fetches = top30.map(async (storyId): Promise<TrendItem | null> => {
    try {
      const item = await httpJson<{
        id: number; title?: string; url?: string; score?: number; type?: string;
      }>(`${HN_ITEM_URL}/${storyId}.json`);

      if (!item?.title) return null;
      return {
        id: `hn-${item.id}`,
        title: item.title,
        source: 'hackernews',
        url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
        score: item.score ?? 0,
        matchesNiche: false,
        detectedAt: new Date().toISOString(),
        metadata: { hn_id: item.id, type: item.type },
      };
    } catch (err) {
      logger.debug({ storyId, err: String(err) }, 'HN item fetch failed');
      return null;
    }
  });

  const results = await Promise.allSettled(fetches);
  const items: TrendItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value !== null) items.push(r.value);
  }
  logger.debug({ count: items.length }, 'HN scan done');
  return items;
}

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------

/**
 * Fetch hot posts from each subreddit using the public .json endpoint.
 * matchesNiche is always false — set by caller.
 */
export async function scanReddit(subreddits: readonly string[] = DEFAULT_SUBREDDITS): Promise<TrendItem[]> {
  logger.debug({ subreddits }, 'Scanning Reddit');
  const items: TrendItem[] = [];
  const failures: string[] = [];

  for (const sub of subreddits) {
    try {
      const data = await httpJson<{
        data?: {
          children?: Array<{
            data?: {
              id: string; title: string; url?: string; score: number;
              permalink?: string; link_flair_text?: string;
            };
          }>;
        };
      }>(`https://www.reddit.com/r/${sub}/hot.json?limit=10`);

      for (const post of data?.data?.children ?? []) {
        const pd = post.data;
        if (!pd?.id || !pd?.title) continue;
        items.push({
          id: `reddit-${pd.id}`,
          title: pd.title,
          source: 'reddit',
          url: pd.url ?? `https://reddit.com${pd.permalink ?? ''}`,
          score: pd.score ?? 0,
          category: sub,
          matchesNiche: false,
          detectedAt: new Date().toISOString(),
          metadata: { subreddit: sub, flair: pd.link_flair_text ?? null },
        });
      }
    } catch (err) {
      const msg = String(err);
      failures.push(msg);
      logger.debug({ sub, err: msg }, 'Reddit subreddit scan failed');
    }
  }

  // Reddit now blocks datacenter IPs on the public .json endpoints — verified
  // 2026-08-01: `GET /r/technology/hot.json` returns **403 Blocked** from this
  // host. Every failure above was logged at debug, so the scanner reported a
  // healthy empty result and the whole source died silently in production.
  //
  // A dead source must be loud. This does not fix Reddit (that needs an OAuth
  // app-only credential, which is an operator decision) — it makes the outage
  // visible instead of letting "trend radar is working" hide 1-of-N sources
  // contributing nothing.
  if (items.length === 0 && failures.length > 0) {
    const blocked = failures.some((f) => f.includes('403'));
    logger.warn(
      { subreddits: subreddits.length, failures: failures.length, sample: failures[0]?.slice(0, 120) },
      blocked
        ? 'Reddit scan returned NOTHING — 403 Blocked. Reddit blocks datacenter IPs on the public ' +
            '.json endpoints; this source needs an OAuth app-only credential to work at all.'
        : 'Reddit scan returned NOTHING — every subreddit request failed.',
    );
  }

  logger.debug({ count: items.length }, 'Reddit scan done');
  return items;
}

// ---------------------------------------------------------------------------
// Google Trends
// ---------------------------------------------------------------------------

/**
 * Parse Google Trends daily trending RSS (US geo).
 * matchesNiche is always false — set by caller.
 */
export async function scanGoogleTrends(): Promise<TrendItem[]> {
  logger.debug('Scanning Google Trends');
  let xml: string;
  try {
    xml = await httpText(GOOGLE_TRENDS_RSS);
  } catch (err) {
    logger.warn({ err: String(err) }, 'Google Trends RSS fetch failed');
    return [];
  }

  const items: TrendItem[] = [];
  const blocks = xml.match(/<item>([\s\S]*?)<\/item>/gi) ?? [];

  for (const block of blocks) {
    const titleMatch = block.match(/<title><!\[CDATA\[(.*?)]]><\/title>/)
                    ?? block.match(/<title>(.*?)<\/title>/);
    const linkMatch  = block.match(/<link>(.*?)<\/link>/);
    const trafficMatch = block.match(/<ht:approx_traffic>(.*?)<\/ht:approx_traffic>/);

    const title = titleMatch?.[1]?.trim();
    if (!title) continue;

    const slug  = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    const score = parseInt((trafficMatch?.[1] ?? '0').replace(/[^0-9]/g, ''), 10) || 0;

    items.push({
      id: `gtrends-${slug}`,
      title,
      source: 'google_trends',
      url: linkMatch?.[1]?.trim(),
      score,
      matchesNiche: false,
      detectedAt: new Date().toISOString(),
      metadata: { approx_traffic: trafficMatch?.[1] ?? null },
    });
  }

  logger.debug({ count: items.length }, 'Google Trends scan done');
  return items;
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

const YT_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

/** Minimal quota-accounting surface, so this module needn't import the ledger class. */
export interface QuotaSpender {
  spend(method: 'videos.list', count?: number): void;
}

export interface YouTubeTrendingOptions {
  /** Data API key. Defaults to `YOUTUBE_API_KEY`. */
  apiKey?: string;
  /** ISO 3166-1 alpha-2. Trending is region-specific; there is no global chart. */
  regionCode?: string;
  /** Optional YouTube category id (e.g. '28' Science & Tech, '25' News & Politics). */
  categoryId?: string;
  /** 1..50. The API caps at 50 per page and we deliberately never paginate. */
  maxResults?: number;
  /** Optional quota ledger. When supplied, one `videos.list` unit is charged. */
  ledger?: QuotaSpender;
}

/**
 * The trending chart for a region — the only source here that is actually YouTube.
 *
 * Uses `videos.list?chart=mostPopular`, which costs **1 quota unit** regardless
 * of `maxResults`. Deliberately *not* `search.list`, which costs 100 units and
 * can consume an entire day's 10,000-unit allowance in ~100 calls (see GAP-02).
 * One call per scan, never paginated, so a scan is 1 unit.
 *
 * Score is `viewCount`, which makes YouTube items numerically much larger than
 * Hacker News points or Reddit upvotes. Callers comparing across sources must
 * normalise; the raw counts are kept because they are the honest measurement.
 *
 * Returns `[]` rather than throwing when unconfigured or on any API error —
 * a dead source must not take down the whole scan.
 */
export async function scanYouTubeTrending(opts: YouTubeTrendingOptions = {}): Promise<TrendItem[]> {
  const apiKey = opts.apiKey ?? process.env['YOUTUBE_API_KEY'];
  if (!apiKey) {
    logger.warn('No YOUTUBE_API_KEY — skipping YouTube trending scan');
    return [];
  }

  const regionCode = opts.regionCode ?? 'US';
  const maxResults = Math.min(Math.max(1, opts.maxResults ?? 25), 50);

  const params = new URLSearchParams({
    part: 'snippet,statistics',
    chart: 'mostPopular',
    regionCode,
    maxResults: String(maxResults),
    key: apiKey,
  });
  if (opts.categoryId) params.set('videoCategoryId', opts.categoryId);

  // Charge before the call: a request that fails still consumed quota.
  try {
    opts.ledger?.spend('videos.list');
  } catch (err) {
    logger.warn({ err: String(err) }, 'YouTube trending scan skipped — quota budget refused it');
    return [];
  }

  let payload: {
    items?: Array<{
      id?: string;
      snippet?: {
        title?: string; channelTitle?: string; categoryId?: string; publishedAt?: string;
      };
      statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
    }>;
  };
  try {
    payload = await httpJson(`${YT_VIDEOS_URL}?${params.toString()}`);
  } catch (err) {
    logger.warn({ err: String(err), regionCode }, 'YouTube trending fetch failed');
    return [];
  }

  const items: TrendItem[] = [];
  for (const v of payload.items ?? []) {
    const title = v.snippet?.title?.trim();
    if (!v.id || !title) continue;
    items.push({
      id: `yt-${v.id}`,
      title,
      source: 'youtube',
      url: `https://youtube.com/watch?v=${v.id}`,
      score: parseInt(v.statistics?.viewCount ?? '0', 10) || 0,
      ...(v.snippet?.categoryId ? { category: v.snippet.categoryId } : {}),
      matchesNiche: false,
      detectedAt: new Date().toISOString(),
      metadata: {
        videoId: v.id,
        channelTitle: v.snippet?.channelTitle ?? null,
        publishedAt: v.snippet?.publishedAt ?? null,
        likeCount: parseInt(v.statistics?.likeCount ?? '0', 10) || 0,
        commentCount: parseInt(v.statistics?.commentCount ?? '0', 10) || 0,
        regionCode,
      },
    });
  }

  logger.debug({ count: items.length, regionCode }, 'YouTube trending scan done');
  return items;
}

// ---------------------------------------------------------------------------
// X / Twitter
// ---------------------------------------------------------------------------

const X_TRENDS_URL = 'https://api.x.com/2/trends/by/woeid';

/** WOEID 1 = worldwide. 23424977 = United States. */
export const WOEID_WORLDWIDE = 1;

export interface XTrendsOptions {
  /** Bearer token. Defaults to `X_API_BEARER_TOKEN`. Absent ⇒ scanner no-ops. */
  bearerToken?: string;
  woeid?: number;
  maxTrends?: number;
}

/**
 * X / Twitter trending topics.
 *
 * **This costs money and is off unless a token is present.** As of 2026-02-06 X
 * removed the free tier for new developers and moved to pay-per-use; trends are
 * billed at roughly $0.010 per call. Hourly polling is therefore ~$7/month —
 * cheap, but non-zero, and spending is the operator's decision, not the
 * system's. With no `X_API_BEARER_TOKEN` this returns `[]` and costs nothing.
 *
 * **UNVERIFIED:** the response shape below is coded from X's documented v2
 * `trends/by/woeid` schema but has **not** been exercised against the live
 * endpoint, because doing so requires a paid credential this project does not
 * hold. The parser is written defensively and returns `[]` on any shape it does
 * not recognise, so a schema drift degrades to "no trends" rather than to bad
 * data. Treat as unproven until someone runs it with a real token.
 */
export async function scanXTrends(opts: XTrendsOptions = {}): Promise<TrendItem[]> {
  const token = opts.bearerToken ?? process.env['X_API_BEARER_TOKEN'];
  if (!token) {
    logger.debug('No X_API_BEARER_TOKEN — skipping X trends scan (paid endpoint, opt-in)');
    return [];
  }

  const woeid = opts.woeid ?? WOEID_WORLDWIDE;
  const maxTrends = Math.min(Math.max(1, opts.maxTrends ?? 25), 50);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  let payload: { data?: Array<{ trend_name?: string; tweet_count?: number }> };
  try {
    const res = await fetch(`${X_TRENDS_URL}/${woeid}?max_trends=${maxTrends}`, {
      signal: ac.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      logger.warn({ status: res.status, woeid }, 'X trends fetch returned non-OK');
      return [];
    }
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    logger.warn({ err: String(err), woeid }, 'X trends fetch failed');
    return [];
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(payload?.data)) {
    logger.warn('X trends response had no data array — returning nothing rather than guessing');
    return [];
  }

  const items: TrendItem[] = [];
  for (const t of payload.data) {
    const title = t.trend_name?.trim();
    if (!title) continue;
    items.push({
      id: `x-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`,
      title,
      source: 'x',
      url: `https://x.com/search?q=${encodeURIComponent(title)}`,
      score: typeof t.tweet_count === 'number' ? t.tweet_count : 0,
      matchesNiche: false,
      detectedAt: new Date().toISOString(),
      metadata: { woeid, tweet_count: t.tweet_count ?? null },
    });
  }

  logger.debug({ count: items.length, woeid }, 'X trends scan done');
  return items;
}
