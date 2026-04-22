/**
 * @file analyzer.ts
 * @description Rule-based emotional content analysis for SUDO-AI v4.
 *
 * Entirely lexicon-driven — zero LLM calls. Provides instant, free emotional
 * signal extraction from arbitrary text, blended with the current state via
 * emotional inertia (80 % existing / 20 % new signal).
 */

import { createLogger } from '../../shared/logger.js';
import type { EmotionTag, EmotionalValence } from '../types.js';

const log = createLogger('consciousness:emotional-memory');

// ---------------------------------------------------------------------------
// Lexicons — const arrays so they are tree-shakeable and never mutated
// ---------------------------------------------------------------------------

const JOY_LEXICON = [
  'success', 'great', 'amazing', 'perfect', 'excellent', 'love',
  'happy', 'wonderful', 'brilliant', 'fantastic', 'milestone',
  'achieved', 'won', 'celebrate',
] as const;

const FRUSTRATION_LEXICON = [
  'error', 'failed', 'broken', 'stuck', 'bug', 'crash', 'timeout',
  'rejected', 'wrong', 'annoying', 'waste', 'impossible', 'damn',
] as const;

const PRIDE_LEXICON = [
  'built', 'created', 'shipped', 'deployed', 'completed', 'improved',
  'optimized', 'solved', 'fixed', 'mastered',
] as const;

const CURIOSITY_LEXICON = [
  'interesting', 'wonder', 'explore', 'research', 'discover',
  'investigate', 'hypothesis', 'experiment', 'why', 'how', 'what if',
] as const;

const SURPRISE_LEXICON = [
  'unexpected', 'suddenly', 'shocked', 'wow', 'incredible',
  'never seen', 'anomaly', 'spike', 'viral', 'bizarre',
] as const;

const SATISFACTION_LEXICON = [
  'done', 'complete', 'working', 'stable', 'reliable',
  'smooth', 'clean', 'solid', 'nominal',
] as const;

const FEAR_LEXICON = [
  'danger', 'risk', 'vulnerable', 'exposed', 'breach',
  'leak', 'corrupt', 'lost', 'delete', 'destroy',
] as const;

const BOREDOM_LEXICON = [
  'routine', 'same', 'nothing', 'idle', 'waiting',
  'quiet', 'slow', 'repetitive',
] as const;

const DETERMINATION_LEXICON = [
  'must', 'will', 'going to', 'need to', 'commit',
  'push', 'grind', 'persist', 'focus',
] as const;

const CALM_LEXICON = [
  'stable', 'peaceful', 'balanced', 'nominal',
  'healthy', 'steady', 'consistent',
] as const;

// ---------------------------------------------------------------------------
// Lexicon map — maps each EmotionTag to its word list
// ---------------------------------------------------------------------------

const LEXICON_MAP: Record<EmotionTag, readonly string[]> = {
  joy:          JOY_LEXICON,
  frustration:  FRUSTRATION_LEXICON,
  pride:        PRIDE_LEXICON,
  curiosity:    CURIOSITY_LEXICON,
  surprise:     SURPRISE_LEXICON,
  satisfaction: SATISFACTION_LEXICON,
  fear:         FEAR_LEXICON,
  boredom:      BOREDOM_LEXICON,
  determination: DETERMINATION_LEXICON,
  calm:         CALM_LEXICON,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count occurrences of each lexicon term in `text` using case-insensitive
 * word-boundary matching. Multi-word phrases are matched as substrings.
 */
function countMatches(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const term of terms) {
    // Word-boundary regex for single-word terms; substring match for phrases.
    if (term.includes(' ')) {
      // Multi-word phrase: plain substring search is sufficient.
      let pos = 0;
      while ((pos = lower.indexOf(term, pos)) !== -1) {
        count++;
        pos += term.length;
      }
    } else {
      // Single word: use \b boundaries.
      const re = new RegExp(`\\b${term}\\b`, 'gi');
      const matches = lower.match(re);
      if (matches) count += matches.length;
    }
  }
  return count;
}

/**
 * Build a scores map from existing EmotionalValence tags.
 * Absent tags default to 0.
 */
function valenceToscores(v: EmotionalValence): Map<EmotionTag, number> {
  const map = new Map<EmotionTag, number>();
  const perTag = v.intensity / Math.max(v.tags.length, 1);
  for (const tag of v.tags) {
    map.set(tag, perTag);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse the emotional content of `text` and blend it with `currentState`
 * using an 80 / 20 inertia rule (80 % existing, 20 % new signal).
 *
 * @param text         - Arbitrary UTF-8 text to analyse.
 * @param currentState - The caller's current EmotionalValence.
 * @returns            A new EmotionalValence reflecting the blended state.
 */
export function analyzeEmotionalContent(
  text: string,
  currentState: EmotionalValence,
): EmotionalValence {
  if (typeof text !== 'string') {
    log.warn({ type: typeof text }, 'analyzeEmotionalContent: non-string text, using empty');
    text = '';
  }

  // ---- Build new-signal score map ----------------------------------------
  const allTags = Object.keys(LEXICON_MAP) as EmotionTag[];
  const newSignal = new Map<EmotionTag, number>();
  let totalNewSignal = 0;

  for (const tag of allTags) {
    const lexicon = LEXICON_MAP[tag];
    const matchCount = countMatches(text, lexicon);
    const score = matchCount * 0.1;
    newSignal.set(tag, score);
    totalNewSignal += score;
  }

  // ---- Build existing-state score map (weight = intensity / tags.length) --
  const existingScores = valenceToscores(currentState);

  // ---- Blend: 80% existing + 20% new signal --------------------------------
  const INERTIA = 0.8;
  const NEW_WEIGHT = 0.2;

  const blended = new Map<EmotionTag, number>();
  let totalBlended = 0;

  for (const tag of allTags) {
    const existScore = existingScores.get(tag) ?? 0;
    const newScore   = totalNewSignal > 0 ? (newSignal.get(tag) ?? 0) : 0;
    const merged = INERTIA * existScore + NEW_WEIGHT * newScore;
    blended.set(tag, merged);
    totalBlended += merged;
  }

  // ---- Normalize so total ~= 1 (guard against zero-sum edge case) ----------
  if (totalBlended > 0) {
    for (const [tag, score] of blended) {
      blended.set(tag, score / totalBlended);
    }
  } else {
    // Fall back: uniform calm baseline
    blended.set('calm', 1.0);
    totalBlended = 1.0;
  }

  // ---- Find dominant emotion -----------------------------------------------
  let dominantEmotion: EmotionTag = 'calm';
  let dominantScore = 0;

  for (const [tag, score] of blended) {
    if (score > dominantScore) {
      dominantScore = score;
      dominantEmotion = tag;
    }
  }

  // ---- Collect active tags (score > threshold) ----------------------------
  const ACTIVE_THRESHOLD = 0.05;
  const activeTags: EmotionTag[] = [];
  for (const [tag, score] of blended) {
    if (score >= ACTIVE_THRESHOLD) activeTags.push(tag);
  }
  if (activeTags.length === 0) activeTags.push(dominantEmotion);

  // ---- Compute blended intensity from dominant score ----------------------
  // Dominant score in normalized map is its relative weight; map to 0..1.
  const intensity = Math.min(1, Math.max(0, dominantScore * activeTags.length));

  const result: EmotionalValence = {
    tags: activeTags,
    dominantEmotion,
    intensity,
  };

  log.debug(
    { dominantEmotion, intensity: intensity.toFixed(3), activeTags },
    'Emotional content analyzed',
  );

  return result;
}
