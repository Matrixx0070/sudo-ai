/**
 * @file fact-extractor.ts
 * @description extractFacts(text) — extract discrete facts from a body of text
 * using regex-based pattern matching for numbers, entities, dates, and claims.
 *
 * Returns an array of Fact objects ordered by confidence (descending).
 */

import type { Fact } from './types.js';

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Matches numeric values with optional units, percentages, or currencies. */
const NUMBER_PATTERNS = [
  /\b(\d{1,3}(?:[,_]\d{3})*(?:\.\d+)?)\s*(percent|%|million|billion|trillion|thousand|kb|mb|gb|tb|ms|seconds?|minutes?|hours?|days?|years?|usd|\$|€|£)?\b/gi,
];

/** Matches named entity-like patterns (proper nouns, capitalized sequences). */
const ENTITY_PATTERNS = [
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,           // Multi-word proper noun
  /\b([A-Z]{2,})\b/g,                                  // Acronym
];

/** Matches date-like strings. */
const DATE_PATTERNS = [
  /\b(\d{4}-\d{2}-\d{2})\b/g,                         // ISO date
  /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/gi,
];

/** Matches claim-like patterns. */
const CLAIM_PATTERNS = [
  /\b(?:according to|studies show|research shows|it is (?:believed|known|estimated) that|evidence suggests)\s+(.{20,120})/gi,
  /\b([A-Z][^.!?]*(?:is|are|was|were|can|will|must|should)\s+[^.!?]{10,80}[.!?])/g,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSentence(text: string, matchIndex: number): string {
  const start = Math.max(0, text.lastIndexOf('.', matchIndex - 1) + 1);
  const endDot = text.indexOf('.', matchIndex);
  const end = endDot === -1 ? Math.min(text.length, matchIndex + 200) : endDot + 1;
  return text.slice(start, end).trim();
}

function dedupeByText(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const key = `${f.type}:${f.text.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract facts from a body of text using pattern matching.
 *
 * @param text - Raw text to process (e.g. article, research, transcript).
 * @returns Array of Fact objects sorted by confidence descending.
 */
export function extractFacts(text: string): Fact[] {
  if (!text || typeof text !== 'string') return [];

  const facts: Fact[] = [];

  // --- Numbers ---
  for (const pattern of NUMBER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1]!;
      const unit = match[2] ?? '';
      facts.push({
        type: 'number',
        text: unit ? `${value} ${unit.trim()}` : value,
        context: getSentence(text, match.index),
        confidence: 0.85,
      });
    }
  }

  // --- Entities ---
  for (const pattern of ENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    const isAcronym = pattern.source.includes('{2,}');
    while ((match = pattern.exec(text)) !== null) {
      const entity = match[1]!;
      // Filter common false positives for acronyms
      if (isAcronym && entity.length > 8) continue;
      facts.push({
        type: 'entity',
        text: entity,
        context: getSentence(text, match.index),
        confidence: isAcronym ? 0.6 : 0.75,
      });
    }
  }

  // --- Dates ---
  for (const pattern of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      facts.push({
        type: 'date',
        text: match[1]!,
        context: getSentence(text, match.index),
        confidence: 0.9,
      });
    }
  }

  // --- Claims ---
  for (const pattern of CLAIM_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const claim = (match[1] ?? match[0]).trim();
      if (claim.length < 20 || claim.length > 300) continue;
      facts.push({
        type: 'claim',
        text: claim,
        context: getSentence(text, match.index),
        confidence: 0.7,
      });
    }
  }

  const deduped = dedupeByText(facts);
  deduped.sort((a, b) => b.confidence - a.confidence);
  return deduped;
}
