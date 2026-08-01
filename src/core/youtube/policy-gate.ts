/**
 * @file policy-gate.ts
 * @description Blocking pre-publish check against YouTube's inauthentic-content policy.
 *
 * Closes GAP-03. YouTube renamed "repetitious content" to "inauthentic content"
 * on 2025-07-15 and — this is the part that makes a gate mandatory rather than
 * nice-to-have — **enforcement reviews the channel as a whole**, not individual
 * videos. One batch of templated uploads retroactively endangers everything
 * already published. A system that can publish six times a day with no policy
 * check can destroy the asset faster than it builds it.
 *
 * What the policy actually penalises (see audit/01-VIABILITY.md Gate 4):
 *   - content "made with a template with little to no variation across videos"
 *   - content "easily replicable at scale"
 *   - slideshows lacking meaningful narration, commentary, or educational substance
 * What it explicitly does NOT penalise: synthetic narration of an original
 * script. So this gate targets SAMENESS, not AI authorship.
 *
 * Two independent checks:
 *   1. Cross-video similarity against recently published scripts — catches the
 *      "one template, 200 videos" failure directly and needs no model.
 *   2. An optional judge for structural variation and substance.
 *
 * Fail-closed by design: a judge that errors or times out yields HOLD, never
 * PASS. Per CLAUDE.md invariant 7 the judge route must be independent of the
 * route that wrote the script; callers pin that, this module only enforces that
 * a missing verdict never becomes an approval.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('youtube:policy-gate');

/** PASS may publish. BLOCK must not. HOLD needs a human — never auto-publish. */
export type PolicyVerdict = 'pass' | 'block' | 'hold';

export interface PublishCandidate {
  title: string;
  /** Full narration script. The similarity check runs against this. */
  script: string;
  description?: string;
}

/** A previously published video, for the sameness comparison. */
export interface PublishedVideo {
  videoId: string;
  title: string;
  script: string;
}

export interface JudgeVerdict {
  /** True when the judge considers the candidate distinct and substantive. */
  original: boolean;
  reason: string;
}

export interface PolicyGateOptions {
  /**
   * Jaccard similarity at or above which two scripts count as the same template.
   * 0.6 is deliberately cautious: Gate 4 punishes false negatives (a templated
   * video reaching the channel) far more harshly than false positives (a script
   * sent back for a rewrite).
   */
  similarityThreshold?: number;
  /** Minimum script length. Shorter than this reads as a slideshow caption. */
  minScriptChars?: number;
  /** Independent judge. Omit to run similarity-only (still a real gate). */
  judge?: (candidate: PublishCandidate) => Promise<JudgeVerdict>;
}

export interface PolicyAssessment {
  verdict: PolicyVerdict;
  reasons: string[];
  /** Highest similarity found against the corpus, 0..1. */
  similarityScore: number;
  /** videoId of the closest prior video, when one was compared. */
  nearestVideoId?: string;
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.6;
const DEFAULT_MIN_SCRIPT_CHARS = 400;

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/**
 * Normalised word shingles. Word-level trigrams catch reordered boilerplate
 * that a bag-of-words comparison would miss.
 */
export function shingles(text: string, n = 3): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length) out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i <= words.length - n; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/** Jaccard similarity of two texts' shingle sets. 1 = identical, 0 = disjoint. */
export function similarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / (sa.size + sb.size - shared);
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Assess a publish candidate. Never throws — a thrown judge becomes HOLD.
 *
 * @param candidate  the video about to be published
 * @param corpus     recently published videos from the same channel
 */
export async function assessPublishCandidate(
  candidate: PublishCandidate,
  corpus: readonly PublishedVideo[] = [],
  opts: PolicyGateOptions = {},
): Promise<PolicyAssessment> {
  const threshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const minChars = opts.minScriptChars ?? DEFAULT_MIN_SCRIPT_CHARS;
  const reasons: string[] = [];

  const script = candidate.script ?? '';
  const title = candidate.title ?? '';

  // --- Structural minimums. These are BLOCK, not HOLD: they are unambiguous.
  if (!title.trim()) reasons.push('Title is empty.');
  if (title.length > 100) {
    reasons.push(`Title is ${title.length} chars; YouTube's limit is 100. Rewrite rather than truncate.`);
  }
  if (!script.trim()) {
    reasons.push('Script is empty — nothing to assess.');
  } else if (script.trim().length < minChars) {
    reasons.push(
      `Script is ${script.trim().length} chars, under the ${minChars}-char minimum. Content this ` +
        'thin reads as a slideshow without meaningful narration.',
    );
  }

  // --- Cross-video sameness. The check that actually maps to the policy.
  let similarityScore = 0;
  let nearestVideoId: string | undefined;
  for (const prior of corpus) {
    const score = similarity(script, prior.script);
    if (score > similarityScore) {
      similarityScore = score;
      nearestVideoId = prior.videoId;
    }
  }
  if (similarityScore >= threshold) {
    reasons.push(
      `Script is ${(similarityScore * 100).toFixed(0)}% similar to already-published ` +
        `${nearestVideoId} (threshold ${(threshold * 100).toFixed(0)}%). YouTube's inauthentic-content ` +
        'policy targets templates with little variation across videos, and enforcement is ' +
        'channel-wide — this endangers the back catalogue, not just this upload.',
    );
  }

  if (reasons.length > 0) {
    log.warn({ title: title.slice(0, 80), similarityScore, reasons }, 'Publish candidate BLOCKED');
    return { verdict: 'block', reasons, similarityScore, ...(nearestVideoId ? { nearestVideoId } : {}) };
  }

  // --- Judge. Absent judge = similarity-only gate; failing judge = HOLD.
  if (opts.judge) {
    try {
      const verdict = await opts.judge(candidate);
      if (!verdict.original) {
        log.warn({ reason: verdict.reason }, 'Publish candidate BLOCKED by judge');
        return {
          verdict: 'block',
          reasons: [`Judge: ${verdict.reason}`],
          similarityScore,
          ...(nearestVideoId ? { nearestVideoId } : {}),
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Policy judge failed — HOLDing rather than passing');
      return {
        verdict: 'hold',
        reasons: [`Policy judge unavailable (${msg}). Held for human review — the gate fails closed.`],
        similarityScore,
        ...(nearestVideoId ? { nearestVideoId } : {}),
      };
    }
  }

  return { verdict: 'pass', reasons: [], similarityScore, ...(nearestVideoId ? { nearestVideoId } : {}) };
}

/** Convenience predicate. Only an explicit `pass` may publish. */
export function mayPublish(assessment: PolicyAssessment): boolean {
  return assessment.verdict === 'pass';
}
