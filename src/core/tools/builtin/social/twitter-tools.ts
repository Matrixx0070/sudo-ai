/**
 * Social Twitter tools: social.twitter-manager, social.trend-scanner.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { missingKey } from './helpers.js';
import { toolFetch } from '../../../security/guarded-fetch.js';

const logger = createLogger('social-twitter');

// ---------------------------------------------------------------------------
// social.twitter-manager
// ---------------------------------------------------------------------------

export const twitterManagerTool: ToolDefinition = {
  name: 'social.twitter-manager',
  description: 'Manage Twitter/X via API v2: tweet, reply, create threads, send DMs, fetch timeline, search tweets, like, retweet. Requires TWITTER_OAUTH2_TOKEN.',
  category: 'social',
  timeout: 30_000,
  parameters: {
    action: { type: 'string', required: true, description: 'Operation.', enum: ['tweet', 'reply', 'thread', 'dm', 'timeline', 'search', 'like', 'retweet'] },
    text: { type: 'string', description: 'Tweet text (required for tweet, reply).' },
    tweetId: { type: 'string', description: 'Tweet ID (required for reply, like, retweet).' },
    userId: { type: 'string', description: 'User ID for DM.' },
    messages: { type: 'array', description: 'Ordered texts for thread.', items: { type: 'string', description: 'Thread tweet text.' } },
    query: { type: 'string', description: 'Search query (required for search).' },
    maxResults: { type: 'number', description: 'Max results for search/timeline (default: 10).', default: 10 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    const oauthToken = process.env['TWITTER_OAUTH2_TOKEN'];
    if (!oauthToken) return missingKey('TWITTER_OAUTH2_TOKEN', 'social.twitter-manager');

    const authHeaders = { Authorization: `Bearer ${oauthToken}`, 'Content-Type': 'application/json' };
    logger.info({ session: ctx.sessionId, action }, 'social.twitter-manager invoked');

    try {
      switch (action) {
        case 'tweet': {
          const text = params['text'] as string | undefined;
          if (!text?.trim()) return { success: false, output: 'text is required.' };
          const res = await toolFetch('https://api.twitter.com/2/tweets', { method: 'POST', headers: authHeaders, signal: ctx.signal, body: JSON.stringify({ text }) });
          const data = await res.json() as { data?: { id: string }; errors?: Array<{ message: string }> };
          if (!res.ok || data.errors) throw new Error(data.errors?.[0]?.message ?? `HTTP ${res.status}`);
          return { success: true, output: `Tweeted (id: ${data.data?.id})`, data: data.data };
        }

        case 'reply': {
          const text = params['text'] as string | undefined;
          const tweetId = params['tweetId'] as string | undefined;
          if (!text?.trim()) return { success: false, output: 'text is required.' };
          if (!tweetId?.trim()) return { success: false, output: 'tweetId is required.' };
          const res = await toolFetch('https://api.twitter.com/2/tweets', {
            method: 'POST', headers: authHeaders, signal: ctx.signal,
            body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: tweetId } }),
          });
          const data = await res.json() as { data?: { id: string }; errors?: Array<{ message: string }> };
          if (!res.ok || data.errors) throw new Error(data.errors?.[0]?.message ?? `HTTP ${res.status}`);
          return { success: true, output: `Reply posted (id: ${data.data?.id})`, data: data.data };
        }

        case 'thread': {
          const messages = params['messages'] as string[] | undefined;
          if (!Array.isArray(messages) || messages.length === 0) return { success: false, output: 'messages array is required.' };
          const postedIds: string[] = [];
          let prevId: string | undefined;
          for (const text of messages) {
            const body: Record<string, unknown> = { text };
            if (prevId) body['reply'] = { in_reply_to_tweet_id: prevId };
            const res = await toolFetch('https://api.twitter.com/2/tweets', { method: 'POST', headers: authHeaders, signal: ctx.signal, body: JSON.stringify(body) });
            const data = await res.json() as { data?: { id: string }; errors?: Array<{ message: string }> };
            if (!res.ok || data.errors) throw new Error(data.errors?.[0]?.message ?? `HTTP ${res.status}`);
            prevId = data.data?.id;
            if (prevId) postedIds.push(prevId);
          }
          return { success: true, output: `Thread of ${postedIds.length} tweets posted.`, data: { tweetIds: postedIds } };
        }

        case 'dm': {
          const userId = params['userId'] as string | undefined;
          const text = params['text'] as string | undefined;
          if (!userId?.trim()) return { success: false, output: 'userId is required.' };
          if (!text?.trim()) return { success: false, output: 'text is required.' };
          const res = await toolFetch(`https://api.twitter.com/2/dm_conversations/with/${userId}/messages`, { method: 'POST', headers: authHeaders, signal: ctx.signal, body: JSON.stringify({ text }) });
          const data = await res.json() as { data?: { dm_conversation_id: string }; errors?: Array<{ message: string }> };
          if (!res.ok || data.errors) throw new Error(data.errors?.[0]?.message ?? `HTTP ${res.status}`);
          return { success: true, output: `DM sent to user ${userId}.`, data: data.data };
        }

        case 'search': {
          const query = params['query'] as string | undefined;
          if (!query?.trim()) return { success: false, output: 'query is required.' };
          const maxResults = Math.max(10, Math.min((params['maxResults'] as number | undefined) ?? 10, 100));
          const qs = new URLSearchParams({ query, max_results: String(maxResults), 'tweet.fields': 'created_at,public_metrics' });
          const res = await toolFetch(`https://api.twitter.com/2/tweets/search/recent?${qs}`, { headers: { Authorization: `Bearer ${oauthToken}` }, signal: ctx.signal });
          const data = await res.json() as { data?: Array<{ id: string; text: string }>; meta?: { result_count: number } };
          if (!res.ok) throw new Error(`Search error HTTP ${res.status}`);
          return { success: true, output: `Found ${data.meta?.result_count ?? 0} tweet(s) for: ${query}`, data: data.data ?? [] };
        }

        case 'timeline': {
          const maxResults = Math.max(5, Math.min((params['maxResults'] as number | undefined) ?? 10, 100));
          const res = await toolFetch(`https://api.twitter.com/2/users/me/timelines/reverse_chronological?max_results=${maxResults}&tweet.fields=created_at`, { headers: { Authorization: `Bearer ${oauthToken}` }, signal: ctx.signal });
          const data = await res.json() as { data?: Array<{ id: string; text: string }> };
          if (!res.ok) throw new Error(`Timeline error HTTP ${res.status}`);
          return { success: true, output: `Timeline: ${(data.data ?? []).length} tweet(s).`, data: data.data ?? [] };
        }

        case 'like':
        case 'retweet': {
          const tweetId = params['tweetId'] as string | undefined;
          if (!tweetId?.trim()) return { success: false, output: `tweetId is required for ${action}.` };
          const meRes = await toolFetch('https://api.twitter.com/2/users/me', { headers: { Authorization: `Bearer ${oauthToken}` }, signal: ctx.signal });
          const me = await meRes.json() as { data?: { id: string } };
          const myId = me.data?.id;
          if (!myId) throw new Error('Could not get authenticated user ID.');
          const endpoint = action === 'like' ? `users/${myId}/likes` : `users/${myId}/retweets`;
          const res = await toolFetch(`https://api.twitter.com/2/${endpoint}`, { method: 'POST', headers: authHeaders, signal: ctx.signal, body: JSON.stringify({ tweet_id: tweetId }) });
          if (!res.ok) throw new Error(`${action} error HTTP ${res.status}`);
          return { success: true, output: `${action === 'like' ? 'Liked' : 'Retweeted'} tweet ${tweetId}.` };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'social.twitter-manager error');
      return { success: false, output: `Twitter manager error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// social.trend-scanner
// ---------------------------------------------------------------------------

export const trendScannerTool: ToolDefinition = {
  name: 'social.trend-scanner',
  description: 'Scan trending topics: Google Trends RSS, Reddit hot posts, Twitter trending (TWITTER_BEARER_TOKEN), YouTube trending (YOUTUBE_API_KEY). Returns ranked topics per platform.',
  category: 'social',
  timeout: 45_000,
  parameters: {
    platforms: { type: 'array', description: 'Platforms to scan (default: google, reddit).', items: { type: 'string', description: 'Platform.', enum: ['google', 'reddit', 'twitter', 'youtube'] }, default: ['google', 'reddit'] },
    category: { type: 'string', description: 'Topic category filter (default: all).', default: 'all' },
    maxResults: { type: 'number', description: 'Max items per platform (default: 10).', default: 10 },
    country: { type: 'string', description: 'ISO 3166-1 alpha-2 country code (default: US).', default: 'US' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const platforms = (params['platforms'] as string[] | undefined) ?? ['google', 'reddit'];
    const maxResults = (params['maxResults'] as number | undefined) ?? 10;
    const country = ((params['country'] as string | undefined) ?? 'US').toUpperCase();
    const category = (params['category'] as string | undefined) ?? 'all';

    logger.info({ session: ctx.sessionId, platforms, country }, 'social.trend-scanner invoked');

    const allTrends: Record<string, unknown[]> = {};
    const errors: string[] = [];

    const fetchSafe = async (url: string, opts: RequestInit = {}): Promise<Response> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12_000);
      try { return await toolFetch(url, { ...opts, signal: ctrl.signal }); }
      finally { clearTimeout(timer); }
    };

    for (const platform of platforms) {
      try {
        if (platform === 'google') {
          const res = await fetchSafe(`https://trends.google.com/trends/trendingsearches/daily/rss?geo=${country}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUDO-AI/4.0)' } });
          const xml = await res.text();
          const titleRegex = /<title><!\[CDATA\[([^\]]+)\]\]><\/title>|<title>([^<]+)<\/title>/g;
          const titles: string[] = [];
          let match: RegExpExecArray | null;
          let first = true;
          while ((match = titleRegex.exec(xml)) !== null && titles.length < maxResults) {
            if (first) { first = false; continue; }
            const t = (match[1] ?? match[2] ?? '').trim();
            if (t) titles.push(t);
          }
          allTrends['google'] = titles.map((t, i) => ({ rank: i + 1, topic: t, platform: 'google' }));

        } else if (platform === 'reddit') {
          const sub = category !== 'all' ? `r/${category}` : 'r/all';
          const res = await fetchSafe(`https://www.reddit.com/${sub}/hot.json?limit=${maxResults}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUDO-AI/4.0)' } });
          const json = await res.json() as { data?: { children?: Array<{ data: { title: string; score: number; url: string } }> } };
          allTrends['reddit'] = (json.data?.children ?? []).slice(0, maxResults).map((p, i) => ({ rank: i + 1, topic: p.data.title, score: p.data.score, url: p.data.url, platform: 'reddit' }));

        } else if (platform === 'twitter') {
          const token = process.env['TWITTER_BEARER_TOKEN'];
          if (!token) { errors.push('twitter: TWITTER_BEARER_TOKEN not configured'); allTrends['twitter'] = []; continue; }
          const woeidMap: Record<string, number> = { US: 23424977, GB: 23424975, IN: 23424848, AU: 23424748 };
          const woeid = woeidMap[country] ?? 1;
          const res = await fetchSafe(`https://api.twitter.com/1.1/trends/place.json?id=${woeid}`, { headers: { Authorization: `Bearer ${token}` } });
          if (!res.ok) throw new Error(`Twitter trends HTTP ${res.status}`);
          const data = await res.json() as Array<{ trends?: Array<{ name: string; tweet_volume?: number }> }>;
          allTrends['twitter'] = (data[0]?.trends ?? []).slice(0, maxResults).map((t, i) => ({ rank: i + 1, topic: t.name, tweetVolume: t.tweet_volume, platform: 'twitter' }));

        } else if (platform === 'youtube') {
          const apiKey = process.env['YOUTUBE_API_KEY'];
          if (!apiKey) { errors.push('youtube: YOUTUBE_API_KEY not configured'); allTrends['youtube'] = []; continue; }
          const qs = new URLSearchParams({ part: 'snippet', chart: 'mostPopular', regionCode: country, maxResults: String(maxResults), key: apiKey });
          const res = await fetchSafe(`https://www.googleapis.com/youtube/v3/videos?${qs}`);
          if (!res.ok) throw new Error(`YouTube trending HTTP ${res.status}`);
          const data = await res.json() as { items?: Array<{ snippet?: { title?: string; channelTitle?: string } }> };
          allTrends['youtube'] = (data.items ?? []).slice(0, maxResults).map((v, i) => ({ rank: i + 1, topic: v.snippet?.title ?? '', channel: v.snippet?.channelTitle ?? '', platform: 'youtube' }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${platform}: ${msg}`);
        logger.warn({ platform, err: msg }, 'Trend scan platform error');
        allTrends[platform] = [];
      }
    }

    const summary = Object.entries(allTrends).map(([p, items]) => `${p}: ${(items as unknown[]).length}`).join(', ');
    return {
      success: errors.length < platforms.length,
      output: `Trend scan complete. ${summary}.${errors.length > 0 ? ` Errors: ${errors.join('; ')}` : ''}`,
      data: { trends: allTrends, totalItems: Object.values(allTrends).flat().length, country, category, errors },
    };
  },
};
