/**
 * comment-types.ts — Shared type definitions for the YouTube Comment Engine.
 *
 * Isolated so both comment-engine.ts and comment-api.ts can import without
 * creating circular dependencies.
 */

/** A single YouTube comment (top-level or reply). */
export interface YouTubeComment {
  /** YouTube comment ID. */
  id: string;
  /** ID of the video this comment belongs to. */
  videoId: string;
  /** Display name of the commenter. */
  authorName: string;
  /** Channel ID of the commenter (may be absent for anonymous). */
  authorChannelId?: string;
  /** Raw comment text (may include HTML entities from the API). */
  text: string;
  /** Number of likes on the comment. */
  likeCount: number;
  /** ISO 8601 timestamp when the comment was published. */
  publishedAt: string;
  /** True if this comment is a reply to another comment. */
  isReply: boolean;
  /** Parent comment ID (present when isReply is true). */
  parentId?: string;
  /** Computed sentiment classification. */
  sentiment?: 'positive' | 'neutral' | 'negative';
  /** Whether SUDO-AI has already replied to this comment. */
  responded: boolean;
}

/** Aggregate statistics for a video or the entire comment store. */
export interface CommentStats {
  total: number;
  responded: number;
  pending: number;
  sentimentBreakdown: { positive: number; neutral: number; negative: number };
  topCommenters: { name: string; count: number }[];
}
