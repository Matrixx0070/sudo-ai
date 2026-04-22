/**
 * TrendRadar source scanners.
 *
 * Each scanner fetches data from a single external source and returns
 * an array of unnormalised TrendItem records (matchesNiche = false).
 * The caller (TrendRadar) applies niche-matching after all scanners return.
 *
 * Sources:
 *   - Hacker News  — Firebase REST JSON API
 *   - Reddit       — Public .json endpoint on subreddit hot listings
 *   - Google Trends — Daily trending RSS feed (US geo)
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
      logger.debug({ sub, err: String(err) }, 'Reddit subreddit scan failed');
    }
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
