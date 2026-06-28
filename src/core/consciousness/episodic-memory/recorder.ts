/**
 * @file recorder.ts
 * @description Pure helper functions for computing episode properties.
 *
 * No database access. No async. All inputs validated, all results logged.
 */

import { createLogger } from '../../shared/logger.js';
import type { EmotionalValence } from '../types.js';
import type { Episode } from './types.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('episodic-memory:recorder');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'not',
  'no', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'each', 'few',
  'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very', 'just',
  'that', 'this', 'these', 'those', 'it', 'its', 'i', 'we', 'you', 'he',
  'she', 'they', 'me', 'us', 'him', 'her', 'them', 'my', 'our', 'your',
  'his', 'their', 'what', 'which', 'who', 'how', 'when', 'where', 'why',
]);

// ---------------------------------------------------------------------------
// computeSignificance
// ---------------------------------------------------------------------------

export interface SignificanceParams {
  surprise: number;
  emotionalIntensity: number;
  messageCount: number;
  toolCallCount: number;
  hasError: boolean;
}

/**
 * Compute a composite significance score [0..1] for an episode.
 *
 * Weights:
 *   base                  = 0.30
 *   surprise * 0.20       = up to 0.20
 *   emotionalIntensity * 0.15 = up to 0.15
 *   messageCount / 20 clamped to 0.15  = up to 0.15
 *   toolCallCount / 10 clamped to 0.10 = up to 0.10
 *   hasError ? 0.10 : 0                = 0 or 0.10
 *
 * @param params - Input metrics.
 * @returns Significance score clamped to [0, 1].
 */
export function computeSignificance(params: SignificanceParams): number {
  const { surprise, emotionalIntensity, messageCount, toolCallCount, hasError } = params;

  if (surprise < 0 || surprise > 1) {
    log.warn({ surprise }, 'computeSignificance: surprise out of [0,1], clamping');
  }
  if (emotionalIntensity < 0 || emotionalIntensity > 1) {
    log.warn({ emotionalIntensity }, 'computeSignificance: emotionalIntensity out of [0,1], clamping');
  }
  if (messageCount < 0) {
    log.warn({ messageCount }, 'computeSignificance: messageCount is negative, treating as 0');
  }
  if (toolCallCount < 0) {
    log.warn({ toolCallCount }, 'computeSignificance: toolCallCount is negative, treating as 0');
  }

  const clamp = (v: number, lo: number, hi: number): number =>
    Math.min(Math.max(v, lo), hi);

  const safeSurprise = clamp(surprise, 0, 1);
  const safeIntensity = clamp(emotionalIntensity, 0, 1);
  const safeMsgCount = Math.max(messageCount, 0);
  const safeToolCount = Math.max(toolCallCount, 0);

  const score =
    0.30 +
    safeSurprise * 0.20 +
    safeIntensity * 0.15 +
    clamp(safeMsgCount / 20, 0, 0.15) +
    clamp(safeToolCount / 10, 0, 0.10) +
    (hasError ? 0.10 : 0);

  const result = clamp(score, 0, 1);

  log.debug(
    { ...params, result },
    'computeSignificance result',
  );

  return result;
}

// ---------------------------------------------------------------------------
// classifyOutcome
// ---------------------------------------------------------------------------

/**
 * Classify the outcome of an episode based on error status and emotional valence.
 *
 * Rules (applied in order):
 *   1. hasError AND dominant emotion is frustration/fear → 'negative'
 *   2. dominant emotion is joy/pride/satisfaction        → 'positive'
 *   3. emotional intensity < 0.3                        → 'neutral'
 *   4. otherwise                                        → 'mixed'
 *
 * @param hasError       - Whether an error occurred during the episode.
 * @param emotionalValence - The emotional state at episode end.
 * @returns Outcome classification.
 */
export function classifyOutcome(
  hasError: boolean,
  emotionalValence: EmotionalValence,
): Episode['outcome'] {
  const { dominantEmotion, intensity } = emotionalValence;

  if (hasError && (dominantEmotion === 'frustration' || dominantEmotion === 'fear')) {
    log.debug({ dominantEmotion, hasError }, 'classifyOutcome → negative');
    return 'negative';
  }

  if (
    dominantEmotion === 'joy' ||
    dominantEmotion === 'pride' ||
    dominantEmotion === 'satisfaction'
  ) {
    log.debug({ dominantEmotion }, 'classifyOutcome → positive');
    return 'positive';
  }

  if (intensity < 0.3) {
    log.debug({ intensity }, 'classifyOutcome → neutral (low intensity)');
    return 'neutral';
  }

  log.debug({ dominantEmotion, intensity, hasError }, 'classifyOutcome → mixed');
  return 'mixed';
}

// ---------------------------------------------------------------------------
// extractTags
// ---------------------------------------------------------------------------

/**
 * Extract up to 5 keyword tags from a block of text.
 *
 * Algorithm:
 *   1. Lowercase and split on whitespace / punctuation.
 *   2. Remove stopwords and tokens shorter than 3 characters.
 *   3. Deduplicate (keep first occurrence).
 *   4. Sort remaining tokens by length descending (longer words = more specific).
 *   5. Return the top 5.
 *
 * @param text - Source text to analyse (e.g. episode summary + topic).
 * @returns Array of up to 5 keyword strings.
 */
export function extractTags(text: string): string[] {
  if (typeof text !== 'string' || text.trim().length === 0) {
    log.debug('extractTags: empty input, returning []');
    return [];
  }

  // Unicode-aware split: break on whitespace, punctuation and symbols but KEEP
  // letters of every script. The old /[\s\W]+/ (no `u` flag, \W = [^A-Za-z0-9_])
  // stripped all non-ASCII, fragmenting "café"→"caf" and dropping CJK/Arabic.
  const tokens = text
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));

  // Count frequency, then dedupe preserving first-seen order.
  const freq = new Map<string, number>();
  const unique: string[] = [];
  for (const t of tokens) {
    const prev = freq.get(t);
    if (prev === undefined) {
      freq.set(t, 1);
      unique.push(t);
    } else {
      freq.set(t, prev + 1);
    }
  }

  // Rank by frequency desc (the actual topic), length desc as a tiebreak. The
  // old length-only sort let a single rare long token outrank a word used 50×.
  unique.sort((a, b) => (freq.get(b)! - freq.get(a)!) || (b.length - a.length));

  const tags = unique.slice(0, 5);

  log.debug({ tags, inputLength: text.length }, 'extractTags result');

  return tags;
}
