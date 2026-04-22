/**
 * meta.comments — registered SUDO-AI tool
 *
 * YouTube Comment Engine tool: fetch, analyze, and respond to comments.
 * Bridges the ToolDefinition interface to the CommentEngine class.
 *
 * Actions:
 *   fetch             — Pull comments from YouTube API for a video or channel
 *   unanswered        — List unanswered top-level comments
 *   reply-suggestions — Generate smart reply suggestions for a comment
 *   post-reply        — Post a reply (requires YOUTUBE_OAUTH_TOKEN)
 *   stats             — Comment stats and sentiment breakdown
 *   superfans         — Top commenters (potential superfans)
 *
 * Environment variables:
 *   YOUTUBE_API_KEY      — YouTube Data API v3 key
 *   YOUTUBE_OAUTH_TOKEN  — OAuth 2.0 token for posting replies
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { CommentEngine } from '../../../youtube/comment-engine.js';

const logger = createLogger('meta.comments');

const DB_PATH = path.resolve('data/mind.db');

// ---------------------------------------------------------------------------
// Lazy singleton — instantiated once per process, reset if env vars change
// ---------------------------------------------------------------------------

let _engine: CommentEngine | null = null;

function getEngine(): CommentEngine {
  if (!_engine) {
    const apiKey = process.env['YOUTUBE_API_KEY'] ?? '';
    _engine = new CommentEngine(apiKey, DB_PATH);
  }
  return _engine;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n < 1 || n > max) {
    throw new Error(`limit must be between 1 and ${max}. Got: ${String(raw)}`);
  }
  return Math.floor(n);
}

function requireString(value: unknown, name: string): string {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`"${name}" is required and must be a non-empty string`);
  return s;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const commentEngineTool: ToolDefinition = {
  name: 'meta.comments',
  description:
    'YouTube Comment Engine. Read, analyze, and respond to YouTube comments to drive ' +
    'algorithm engagement. Actions: fetch (pull comments from API), unanswered (list pending ' +
    'replies), reply-suggestions (AI-style smart suggestions), post-reply (post via OAuth), ' +
    'stats (sentiment breakdown, totals), superfans (top commenters). ' +
    'Requires YOUTUBE_API_KEY for live data; works on stored data without it. ' +
    'Requires YOUTUBE_OAUTH_TOKEN for post-reply.',
  category: 'meta',
  timeout: 60_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description:
        'Operation to perform. ' +
        '"fetch": pull comments for a videoId or all recent videos for a channelId. ' +
        '"unanswered": list top-level comments that have not been replied to. ' +
        '"reply-suggestions": generate smart reply options for a specific commentId. ' +
        '"post-reply": post a reply to a comment (requires YOUTUBE_OAUTH_TOKEN). ' +
        '"stats": comment statistics including sentiment breakdown. ' +
        '"superfans": top recurring commenters sorted by activity.',
      enum: ['fetch', 'unanswered', 'reply-suggestions', 'post-reply', 'stats', 'superfans'],
    },
    videoId: {
      type: 'string',
      description: 'YouTube video ID. Required for fetch (when not using channelId), unanswered (optional filter), stats (optional filter).',
    },
    channelId: {
      type: 'string',
      description: 'YouTube channel ID (e.g. UCxxxxxx). Used with fetch to pull comments for recent videos.',
    },
    commentId: {
      type: 'string',
      description: 'YouTube comment ID. Required for reply-suggestions and post-reply.',
    },
    replyText: {
      type: 'string',
      description: 'Text of the reply to post. Required for post-reply.',
    },
    maxResults: {
      type: 'number',
      description: 'Max comments to fetch per video (1–100, default 50). Used with fetch.',
      default: 50,
    },
    videoCount: {
      type: 'number',
      description: 'Number of recent videos to fetch comments for when using channelId (1–50, default 10).',
      default: 10,
    },
    limit: {
      type: 'number',
      description: 'Max rows to return for unanswered / superfans (1–100, default 20).',
      default: 20,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(params['action'] ?? '').trim();
    logger.info({ session: ctx.sessionId, action }, 'meta.comments invoked');

    try {
      const engine = getEngine();

      switch (action) {

        // --------------------------------------------------------------------
        case 'fetch': {
          const videoId = (params['videoId'] as string | undefined)?.trim();
          const channelId = (params['channelId'] as string | undefined)?.trim();

          if (!videoId && !channelId) {
            return { success: false, output: 'Either videoId or channelId is required for action=fetch.' };
          }

          if (channelId) {
            const videoCount = validateLimit(params['videoCount'], 10, 50);
            logger.info({ channelId, videoCount }, 'Fetching comments for channel');
            const comments = await engine.fetchAllRecent(channelId, videoCount);
            return {
              success: true,
              output: formatFetchResult(comments),
              data: { count: comments.length, sample: comments.slice(0, 5) },
            };
          }

          const maxResults = validateLimit(params['maxResults'], 50, 100);
          logger.info({ videoId, maxResults }, 'Fetching comments for video');
          const comments = await engine.fetchComments(videoId!, maxResults);
          return {
            success: true,
            output: formatFetchResult(comments),
            data: { count: comments.length, sample: comments.slice(0, 5) },
          };
        }

        // --------------------------------------------------------------------
        case 'unanswered': {
          const videoId = (params['videoId'] as string | undefined)?.trim();
          const limit = validateLimit(params['limit'], 20, 100);
          const comments = engine.getUnanswered(videoId || undefined, limit);
          if (comments.length === 0) {
            return { success: true, output: 'No unanswered comments found. Run action=fetch first.', data: [] };
          }
          const lines = comments.map((c, i) =>
            `${i + 1}. [${c.id}] ${c.authorName} (${c.sentiment ?? 'neutral'}, ${c.likeCount} likes)\n   "${c.text.slice(0, 120)}${c.text.length > 120 ? '...' : ''}"`,
          );
          return {
            success: true,
            output: `${comments.length} unanswered comment(s)${videoId ? ` for video ${videoId}` : ''}:\n\n${lines.join('\n\n')}`,
            data: comments,
          };
        }

        // --------------------------------------------------------------------
        case 'reply-suggestions': {
          const commentId = requireString(params['commentId'], 'commentId');
          const stored = engine.getUnanswered(undefined, 200).find(c => c.id === commentId);
          if (!stored) {
            return { success: false, output: `Comment "${commentId}" not found in stored data. Run fetch first.` };
          }
          const suggestions = engine.generateReplySuggestions(stored);
          if (suggestions.length === 0) {
            return { success: true, output: 'No suggestions generated for this comment.', data: [] };
          }
          const lines = suggestions.map((s, i) => `${i + 1}. "${s}"`);
          return {
            success: true,
            output: `Reply suggestions for comment by ${stored.authorName}:\n\n${lines.join('\n')}`,
            data: { commentId, comment: stored, suggestions },
          };
        }

        // --------------------------------------------------------------------
        case 'post-reply': {
          const commentId = requireString(params['commentId'], 'commentId');
          const replyText = requireString(params['replyText'], 'replyText');
          if (replyText.length > 10_000) {
            return { success: false, output: 'replyText must be under 10,000 characters.' };
          }
          logger.info({ commentId }, 'Posting reply via meta.comments');
          const result = await engine.postReply(commentId, replyText);
          return {
            success: result.success,
            output: result.message,
            data: { commentId, replyText, success: result.success },
          };
        }

        // --------------------------------------------------------------------
        case 'stats': {
          const videoId = (params['videoId'] as string | undefined)?.trim();
          const stats = engine.getStats(videoId || undefined);
          const topLines = stats.topCommenters.map(t => `  - ${t.name}: ${t.count} comment(s)`).join('\n');
          const output = [
            `Comment Stats${videoId ? ` — video ${videoId}` : ' (all videos)'}:`,
            `  Total:     ${stats.total}`,
            `  Responded: ${stats.responded}`,
            `  Pending:   ${stats.pending}`,
            `  Sentiment: ${stats.sentimentBreakdown.positive} positive / ${stats.sentimentBreakdown.neutral} neutral / ${stats.sentimentBreakdown.negative} negative`,
            stats.topCommenters.length > 0 ? `  Top commenters:\n${topLines}` : '',
          ].filter(Boolean).join('\n');
          return { success: true, output, data: stats };
        }

        // --------------------------------------------------------------------
        case 'superfans': {
          const limit = validateLimit(params['limit'], 10, 100);
          const superfans = engine.getSuperfans(limit);
          if (superfans.length === 0) {
            return { success: true, output: 'No superfans identified yet. Fetch more comments first.', data: [] };
          }
          const lines = superfans.map((f, i) =>
            `${i + 1}. ${f.name} — ${f.comments} comment(s) | avg sentiment: ${f.avgSentiment}`,
          );
          return {
            success: true,
            output: `Top ${superfans.length} superfan(s):\n\n${lines.join('\n')}`,
            data: superfans,
          };
        }

        // --------------------------------------------------------------------
        default:
          return { success: false, output: `Unknown action: "${action}". Valid actions: fetch, unanswered, reply-suggestions, post-reply, stats, superfans.` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.comments error');
      return { success: false, output: `Comment engine error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatFetchResult(comments: Array<{ videoId: string; authorName: string; text: string; sentiment?: string; likeCount: number }>): string {
  if (comments.length === 0) return 'No comments found. Check videoId/channelId and ensure YOUTUBE_API_KEY is set.';
  const sample = comments.slice(0, 5).map((c, i) =>
    `  ${i + 1}. [${c.videoId}] ${c.authorName} (${c.sentiment ?? 'neutral'}, ${c.likeCount} likes)\n     "${c.text.slice(0, 100)}${c.text.length > 100 ? '...' : ''}"`,
  );
  return `Fetched and stored ${comments.length} comment(s):\n${sample.join('\n')}${comments.length > 5 ? `\n  ... and ${comments.length - 5} more` : ''}`;
}
