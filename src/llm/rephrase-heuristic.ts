/**
 * Rephrase heuristic (gw-refactor Phase 5 outcome signal) — pure text logic,
 * no DB coupling; split from logging.ts under the max-lines ratchet.
 */

/** Jaccard similarity of the lowercase word sets of two strings (0–1). */
export function jaccardWordSimilarity(a: string, b: string): number {
  const ta = new Set(a.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const tb = new Set(b.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Conservative, dependency-free "user rephrased the same ask" heuristic:
 * both messages must be non-trivial (>10 chars trimmed) and share >0.6 of
 * their word vocabulary (Jaccard on word sets). Deliberately cheap — runs on
 * the message-intake hot path. A distinct follow-up question shares far less
 * vocabulary; short acks ("ok", "thanks") are excluded by the length guard.
 */
export function isLikelyRephrase(prev: string, next: string): boolean {
  if (typeof prev !== 'string' || typeof next !== 'string') return false;
  if (prev.trim().length <= 10 || next.trim().length <= 10) return false;
  return jaccardWordSimilarity(prev, next) > 0.6;
}
