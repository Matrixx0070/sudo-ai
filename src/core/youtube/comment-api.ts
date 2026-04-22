/**
 * comment-api.ts — HTTP helpers for YouTube Data API v3 comments endpoints.
 *
 * All functions are pure (no DB side-effects). They call the YouTube API
 * using native fetch() and return typed results.
 *
 * Environment variables consumed by callers:
 *   YOUTUBE_API_KEY      — YouTube Data API v3 key
 *   YOUTUBE_OAUTH_TOKEN  — OAuth 2.0 token for write operations
 */

import { createLogger } from '../shared/logger.js';
import type { YouTubeComment } from './comment-types.js';

const logger = createLogger('comment-api');
const YT_DATA_BASE = 'https://www.googleapis.com/youtube/v3';

// ---------------------------------------------------------------------------
// Internal YouTube API response shapes
// ---------------------------------------------------------------------------

interface YTCommentSnippet {
  authorDisplayName?: string;
  authorChannelId?: { value?: string };
  textDisplay?: string;
  likeCount?: number;
  publishedAt?: string;
  parentId?: string;
}

interface YTCommentThread {
  id: string;
  snippet?: {
    videoId?: string;
    topLevelComment?: { id?: string; snippet?: YTCommentSnippet };
  };
  replies?: {
    comments?: Array<{ id?: string; snippet?: YTCommentSnippet }>;
  };
}

interface YTCommentThreadResponse {
  items?: YTCommentThread[];
  nextPageToken?: string;
}

interface YTSearchItem {
  id?: { videoId?: string };
}

interface YTSearchResponse {
  items?: YTSearchItem[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------------------
// Generic HTTP helper
// ---------------------------------------------------------------------------

async function ytFetch<T>(url: string, label: string, init?: RequestInit): Promise<T> {
  logger.debug({ url, label }, 'YouTube HTTP request');
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

/**
 * Fetch comment threads for a single video from YouTube Data API v3.
 * Includes top-level comments and their replies (up to 100 per thread).
 */
export async function fetchCommentThreads(
  videoId: string,
  apiKey: string,
  maxResults: number,
  analyzeSentimentFn: (text: string) => 'positive' | 'neutral' | 'negative',
): Promise<YouTubeComment[]> {
  const url =
    `${YT_DATA_BASE}/commentThreads?part=snippet,replies` +
    `&videoId=${encodeURIComponent(videoId)}` +
    `&maxResults=${maxResults}&order=relevance&key=${apiKey}`;

  const data = await ytFetch<YTCommentThreadResponse>(url, 'commentThreads');
  const comments: YouTubeComment[] = [];

  for (const thread of data.items ?? []) {
    const top = thread.snippet?.topLevelComment;
    if (!top?.id) continue;

    const ts = top.snippet ?? {};
    const rawText = ts.textDisplay ?? '';
    comments.push({
      id: top.id,
      videoId: thread.snippet?.videoId ?? videoId,
      authorName: ts.authorDisplayName ?? 'Unknown',
      authorChannelId: ts.authorChannelId?.value,
      text: rawText,
      likeCount: ts.likeCount ?? 0,
      publishedAt: ts.publishedAt ?? new Date().toISOString(),
      isReply: false,
      sentiment: analyzeSentimentFn(rawText),
      responded: false,
    });

    for (const reply of thread.replies?.comments ?? []) {
      if (!reply.id) continue;
      const rs = reply.snippet ?? {};
      const replyText = rs.textDisplay ?? '';
      comments.push({
        id: reply.id,
        videoId: thread.snippet?.videoId ?? videoId,
        authorName: rs.authorDisplayName ?? 'Unknown',
        authorChannelId: rs.authorChannelId?.value,
        text: replyText,
        likeCount: rs.likeCount ?? 0,
        publishedAt: rs.publishedAt ?? new Date().toISOString(),
        isReply: true,
        parentId: rs.parentId ?? top.id,
        sentiment: analyzeSentimentFn(replyText),
        responded: false,
      });
    }
  }

  logger.info({ videoId, count: comments.length }, 'Comment threads fetched');
  return comments;
}

/**
 * Fetch the most recent video IDs for a channel using the YouTube search endpoint.
 */
export async function fetchRecentVideoIds(
  channelId: string,
  apiKey: string,
  videoCount: number,
): Promise<string[]> {
  const url =
    `${YT_DATA_BASE}/search?part=id&channelId=${encodeURIComponent(channelId)}` +
    `&type=video&order=date&maxResults=${videoCount}&key=${apiKey}`;

  const data = await ytFetch<YTSearchResponse>(url, 'search.list');
  const ids = (data.items ?? [])
    .map(item => item.id?.videoId)
    .filter((id): id is string => Boolean(id));

  logger.info({ channelId, count: ids.length }, 'Recent video IDs fetched');
  return ids;
}

/**
 * Post a reply to a comment using OAuth 2.0.
 * Returns { success, message }.
 */
export async function postCommentReply(
  commentId: string,
  text: string,
  apiKey: string,
  oauthToken: string,
): Promise<{ success: boolean; message: string }> {
  const url = `${YT_DATA_BASE}/comments?part=snippet&key=${apiKey}`;
  const body = JSON.stringify({ snippet: { parentId: commentId, textOriginal: text } });

  logger.info({ commentId }, 'Posting reply to YouTube API');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    logger.error({ commentId, status: res.status }, 'Reply post failed');
    return { success: false, message: `YouTube API error ${res.status}: ${errBody.slice(0, 200)}` };
  }

  logger.info({ commentId }, 'Reply posted successfully');
  return { success: true, message: `Reply posted to comment ${commentId}` };
}
