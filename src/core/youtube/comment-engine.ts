/**
 * comment-engine.ts — YouTube Comment Engine (DB layer + orchestration).
 *
 * Responsibilities:
 *   - Initialise and manage the SQLite schema for youtube_comments.
 *   - Orchestrate API calls (delegated to comment-api.ts).
 *   - Persist and query comments.
 *   - Expose stats and superfan discovery.
 *
 * Sentiment analysis and reply suggestions are in comment-helpers.ts.
 * Raw HTTP calls are in comment-api.ts.
 *
 * Environment variables:
 *   YOUTUBE_API_KEY      — YouTube Data API v3 key
 *   YOUTUBE_OAUTH_TOKEN  — OAuth 2.0 token for posting replies
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { YouTubeComment, CommentStats } from './comment-types.js';
import { analyzeSentiment, generateReplySuggestions, rowToComment } from './comment-helpers.js';
import { fetchCommentThreads, fetchRecentVideoIds, postCommentReply } from './comment-api.js';

export type { YouTubeComment, CommentStats } from './comment-types.js';

const logger = createLogger('comment-engine');

// ---------------------------------------------------------------------------
// CommentEngine
// ---------------------------------------------------------------------------

export class CommentEngine {
  private readonly db: Database.Database;

  constructor(
    private readonly apiKey: string,
    private readonly dbPath: string,
  ) {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    logger.info({ dbPath }, 'CommentEngine initialised');
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS youtube_comments (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        author_name TEXT,
        author_channel_id TEXT,
        text TEXT NOT NULL,
        like_count INTEGER DEFAULT 0,
        published_at TEXT,
        is_reply INTEGER DEFAULT 0,
        parent_id TEXT,
        sentiment TEXT DEFAULT 'neutral',
        responded INTEGER DEFAULT 0,
        fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_yc_video ON youtube_comments(video_id);
      CREATE INDEX IF NOT EXISTS idx_yc_responded ON youtube_comments(responded);
    `);
    logger.debug('Comment schema initialised');
  }

  // ---------------------------------------------------------------------------
  // Fetch from API
  // ---------------------------------------------------------------------------

  async fetchComments(videoId: string, maxResults = 100): Promise<YouTubeComment[]> {
    if (!videoId?.trim()) throw new Error('videoId is required');

    if (!this.apiKey) {
      logger.warn({ videoId }, 'No YOUTUBE_API_KEY — returning stored comments only');
      return this.getUnanswered(videoId, maxResults);
    }

    const capped = Math.min(Math.max(1, maxResults), 100);
    logger.info({ videoId, maxResults: capped }, 'Fetching comments from YouTube API');

    const comments = await fetchCommentThreads(videoId, this.apiKey, capped, analyzeSentiment);
    this.storeComments(comments);
    return comments;
  }

  async fetchAllRecent(channelId: string, videoCount = 10): Promise<YouTubeComment[]> {
    if (!channelId?.trim()) throw new Error('channelId is required');

    if (!this.apiKey) {
      logger.warn('No YOUTUBE_API_KEY — returning stored data only');
      return this.getAllStoredComments();
    }

    const capped = Math.min(Math.max(1, videoCount), 50);
    logger.info({ channelId, videoCount: capped }, 'Fetching recent videos for channel');

    const videoIds = await fetchRecentVideoIds(channelId, this.apiKey, capped);
    if (videoIds.length === 0) {
      logger.info({ channelId }, 'No videos found for channel');
      return [];
    }

    const allComments: YouTubeComment[] = [];
    for (const videoId of videoIds) {
      try {
        const comments = await this.fetchComments(videoId, 50);
        allComments.push(...comments);
      } catch (err) {
        logger.warn({ videoId, err: (err as Error).message }, 'Failed to fetch comments for video — skipping');
      }
    }

    logger.info({ channelId, videos: videoIds.length, total: allComments.length }, 'fetchAllRecent complete');
    return allComments;
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  storeComments(comments: YouTubeComment[]): void {
    if (!Array.isArray(comments) || comments.length === 0) return;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO youtube_comments
        (id, video_id, author_name, author_channel_id, text, like_count,
         published_at, is_reply, parent_id, sentiment, responded)
      VALUES
        (@id, @videoId, @authorName, @authorChannelId, @text, @likeCount,
         @publishedAt, @isReply, @parentId, @sentiment, @responded)
    `);

    const runBatch = this.db.transaction((rows: YouTubeComment[]) => {
      for (const c of rows) {
        insert.run({
          id: c.id, videoId: c.videoId,
          authorName: c.authorName, authorChannelId: c.authorChannelId ?? null,
          text: c.text, likeCount: c.likeCount, publishedAt: c.publishedAt,
          isReply: c.isReply ? 1 : 0, parentId: c.parentId ?? null,
          sentiment: c.sentiment ?? 'neutral', responded: c.responded ? 1 : 0,
        });
      }
    });

    runBatch(comments);
    logger.debug({ count: comments.length }, 'Comments stored');
  }

  // ---------------------------------------------------------------------------
  // Sentiment (delegates to helpers module)
  // ---------------------------------------------------------------------------

  analyzeSentiment(text: string): 'positive' | 'neutral' | 'negative' {
    return analyzeSentiment(text);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  getUnanswered(videoId?: string, limit = 20): YouTubeComment[] {
    const cap = Math.min(Math.max(1, limit), 200);
    const rows = videoId
      ? this.db.prepare(
          `SELECT * FROM youtube_comments WHERE responded=0 AND video_id=? AND is_reply=0 ORDER BY like_count DESC LIMIT ?`,
        ).all(videoId, cap)
      : this.db.prepare(
          `SELECT * FROM youtube_comments WHERE responded=0 AND is_reply=0 ORDER BY like_count DESC LIMIT ?`,
        ).all(cap);

    return (rows as Record<string, unknown>[]).map(rowToComment);
  }

  private getAllStoredComments(): YouTubeComment[] {
    const rows = this.db.prepare(
      `SELECT * FROM youtube_comments ORDER BY published_at DESC LIMIT 500`,
    ).all();
    return (rows as Record<string, unknown>[]).map(rowToComment);
  }

  // ---------------------------------------------------------------------------
  // Reply
  // ---------------------------------------------------------------------------

  async postReply(commentId: string, text: string): Promise<{ success: boolean; message: string }> {
    if (!commentId?.trim()) return { success: false, message: 'commentId is required' };
    if (!text?.trim()) return { success: false, message: 'reply text is required' };

    const oauthToken = process.env['YOUTUBE_OAUTH_TOKEN'];
    if (!oauthToken) {
      logger.warn({ commentId }, 'No YOUTUBE_OAUTH_TOKEN — reply stubbed (logged only)');
      return {
        success: false,
        message: `[STUB] Would reply to comment ${commentId}: "${text.slice(0, 100)}". Set YOUTUBE_OAUTH_TOKEN to enable real replies.`,
      };
    }

    const result = await postCommentReply(commentId, text, this.apiKey, oauthToken);
    if (result.success) this.markResponded(commentId);
    return result;
  }

  markResponded(commentId: string): void {
    if (!commentId?.trim()) return;
    this.db.prepare(`UPDATE youtube_comments SET responded=1 WHERE id=?`).run(commentId);
    logger.debug({ commentId }, 'Comment marked responded');
  }

  // ---------------------------------------------------------------------------
  // Reply suggestions (delegates to helpers module)
  // ---------------------------------------------------------------------------

  generateReplySuggestions(comment: YouTubeComment): string[] {
    return generateReplySuggestions(comment);
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  getStats(videoId?: string): CommentStats {
    const safeId = videoId?.replace(/'/g, "''");
    const where = safeId ? `WHERE video_id='${safeId}'` : '';
    const andWhere = safeId ? `WHERE video_id='${safeId}' AND` : 'WHERE';

    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM youtube_comments ${where}`).get() as { n: number }).n;
    const responded = (this.db.prepare(`SELECT COUNT(*) AS n FROM youtube_comments ${andWhere} responded=1`).get() as { n: number }).n;

    const sentiments = this.db.prepare(
      `SELECT sentiment, COUNT(*) AS n FROM youtube_comments ${where} GROUP BY sentiment`,
    ).all() as Array<{ sentiment: string; n: number }>;

    const breakdown = { positive: 0, neutral: 0, negative: 0 };
    for (const row of sentiments) {
      const key = row.sentiment as keyof typeof breakdown;
      if (key in breakdown) breakdown[key] = row.n;
    }

    const topRows = this.db.prepare(
      `SELECT author_name AS name, COUNT(*) AS count FROM youtube_comments ${where} GROUP BY author_name ORDER BY count DESC LIMIT 5`,
    ).all() as Array<{ name: string; count: number }>;

    return { total, responded, pending: total - responded, sentimentBreakdown: breakdown, topCommenters: topRows };
  }

  // ---------------------------------------------------------------------------
  // Superfans
  // ---------------------------------------------------------------------------

  getSuperfans(limit = 10): { name: string; comments: number; avgSentiment: string }[] {
    const cap = Math.min(Math.max(1, limit), 100);
    const rows = this.db.prepare(`
      SELECT
        author_name AS name,
        COUNT(*) AS comments,
        SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END) AS pos,
        SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) AS neg
      FROM youtube_comments
      WHERE author_name IS NOT NULL
      GROUP BY author_name
      HAVING COUNT(*) > 1
      ORDER BY comments DESC
      LIMIT ?
    `).all(cap) as Array<{ name: string; comments: number; pos: number; neg: number }>;

    return rows.map(r => ({
      name: r.name,
      comments: r.comments,
      avgSentiment: r.pos > r.neg ? 'positive' : r.neg > r.pos ? 'negative' : 'neutral',
    }));
  }
}
