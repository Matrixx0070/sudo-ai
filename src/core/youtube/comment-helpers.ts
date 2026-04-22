/**
 * comment-helpers.ts — Pure helper functions for the YouTube Comment Engine.
 *
 * Contains:
 *   - Keyword-based sentiment analyser
 *   - Reply suggestion generator
 */

import type { YouTubeComment } from './comment-types.js';

// ---------------------------------------------------------------------------
// Sentiment word lists
// ---------------------------------------------------------------------------

const POSITIVE_WORDS = new Set([
  'great', 'love', 'amazing', 'awesome', 'excellent', 'fantastic', 'wonderful',
  'best', 'helpful', 'thanks', 'thank', 'good', 'nice', 'brilliant', 'perfect',
  'superb', 'incredible', 'outstanding', 'beautiful', 'enjoy', 'enjoyed', 'useful',
  'like', 'liked', 'glad', 'happy', 'wow', 'impressive', 'informative', 'clear',
]);

const NEGATIVE_WORDS = new Set([
  'bad', 'hate', 'terrible', 'awful', 'worst', 'boring', 'waste', 'useless',
  'disappointing', 'disappointed', 'wrong', 'incorrect', 'error', 'broken',
  'poor', 'horrible', 'misleading', 'dislike', 'skip', 'stupid', 'trash',
  'garbage', 'clickbait', 'scam', 'fake', 'false',
]);

// ---------------------------------------------------------------------------
// Sentiment analysis
// ---------------------------------------------------------------------------

/**
 * Classify text sentiment using a simple keyword scoring approach.
 * Returns 'positive', 'neutral', or 'negative'.
 */
export function analyzeSentiment(text: string): 'positive' | 'neutral' | 'negative' {
  if (!text?.trim()) return 'neutral';
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/);
  let score = 0;
  for (const word of words) {
    if (POSITIVE_WORDS.has(word)) score++;
    if (NEGATIVE_WORDS.has(word)) score--;
  }
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Reply suggestions
// ---------------------------------------------------------------------------

/**
 * Generate up to 5 contextual reply suggestions based on the comment
 * text, sentiment, and detected intent keywords.
 */
export function generateReplySuggestions(comment: YouTubeComment): string[] {
  if (!comment?.text?.trim()) return [];

  const text = comment.text.toLowerCase();
  const sentiment = comment.sentiment ?? analyzeSentiment(comment.text);
  const name = comment.authorName;
  const suggestions: string[] = [];

  if (sentiment === 'positive') {
    suggestions.push(
      `Thank you so much ${name}! Really appreciate your support.`,
      `Glad you found it helpful! More content coming soon.`,
      `That means a lot — thanks for watching!`,
    );
  } else if (sentiment === 'negative') {
    suggestions.push(
      `Thanks for the feedback, ${name}. I'll work on improving this.`,
      `Sorry to hear that — could you share what specifically could be better?`,
      `Appreciate the honesty. Always looking to improve.`,
    );
  } else {
    suggestions.push(
      `Thanks for watching, ${name}!`,
      `Appreciate you taking the time to comment!`,
      `Great to hear from you — stay tuned for more.`,
    );
  }

  if (text.includes('?')) {
    suggestions.push(`Great question! I'll address this in an upcoming video.`);
  }
  if (text.includes('tutorial') || text.includes('how to')) {
    suggestions.push(`A full tutorial is in the works — stay tuned!`);
  }
  if (text.includes('subscribe') || text.includes('sub')) {
    suggestions.push(`Welcome to the channel!`);
  }

  return [...new Set(suggestions)].slice(0, 5);
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

/**
 * Map a raw better-sqlite3 row to a {@link YouTubeComment} object.
 */
export function rowToComment(row: Record<string, unknown>): YouTubeComment {
  return {
    id: row['id'] as string,
    videoId: row['video_id'] as string,
    authorName: (row['author_name'] as string | null) ?? 'Unknown',
    authorChannelId: (row['author_channel_id'] as string | null) ?? undefined,
    text: row['text'] as string,
    likeCount: (row['like_count'] as number) ?? 0,
    publishedAt: (row['published_at'] as string) ?? '',
    isReply: Number(row['is_reply']) === 1,
    parentId: (row['parent_id'] as string | null) ?? undefined,
    sentiment: (row['sentiment'] as 'positive' | 'neutral' | 'negative' | null) ?? 'neutral',
    responded: Number(row['responded']) === 1,
  };
}
