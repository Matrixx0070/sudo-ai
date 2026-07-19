/**
 * @file index.ts
 * @description Public API for the episodic-memory subsystem.
 *
 * EpisodicMemory wraps ConsciousnessDB and delegates persistence to store.ts
 * and text search to retrieval.ts. Input validation happens here before any
 * DB call is made.
 */

import { createLogger } from '../../shared/logger.js';
import { genId } from '../../shared/utils.js';
import { ConsciousnessError } from '../errors.js';
import { isZDRBlocked } from '../../privacy/zdr-mode.js';
import type { ConsciousnessDB } from '../consciousness-db.js';
import type { EmotionTag } from '../types.js';
import type { Episode, EpisodeQuery } from './types.js';
import {
  saveEpisode,
  queryEpisodes,
  getRecent,
  getBySignificance,
  getByEmotion,
  strengthenEpisode,
  weakenEpisode,
} from './store.js';
import { searchEpisodes } from './retrieval.js';

// ---------------------------------------------------------------------------
// Deduplication config
// ---------------------------------------------------------------------------

/**
 * Episodes whose summary is byte-identical to one already recorded within this
 * window are treated as a recurrence rather than a new episode: the prior
 * episode is strengthened and the duplicate insert is skipped. This collapses
 * heartbeat-replay loops and repeated greetings that would otherwise accumulate
 * (observed: 781 rows / 136 distinct summaries, one heartbeat ×178).
 *
 * Opt-in (default off, preserving the prior always-insert behaviour): enable
 * with SUDO_EPISODIC_DEDUP=1. Window tunable via SUDO_EPISODIC_DEDUP_WINDOW_MS.
 * Both env vars are read per-call so the daemon can toggle without code change.
 */
function dedupEnabled(): boolean {
  return process.env.SUDO_EPISODIC_DEDUP === '1';
}
function dedupWindowMs(): number {
  const raw = Number(process.env.SUDO_EPISODIC_DEDUP_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000; // 24h default
}
/** Significance bump applied to the surviving episode on each suppressed recurrence. */
const DEDUP_STRENGTHEN_DELTA = 0.02;

// Re-export types so callers only need to import from this barrel.
export type { Episode, EpisodeQuery } from './types.js';
export {
  computeSignificance,
  computeEpisodeSignals,
  classifyOutcome,
  extractTags,
} from './recorder.js';

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger('episodic-memory');

// ---------------------------------------------------------------------------
// EpisodicMemory
// ---------------------------------------------------------------------------

/**
 * High-level interface to the episodic memory store.
 *
 * Instantiate with a ConsciousnessDB. All methods are synchronous
 * (better-sqlite3 is synchronous throughout).
 *
 * ```ts
 * const cdb = new ConsciousnessDB();
 * const mem = new EpisodicMemory(cdb);
 *
 * mem.recordEpisode(episode);
 * const recent = mem.getRecent(10);
 * ```
 */
export class EpisodicMemory {
  private readonly cdb: ConsciousnessDB;

  /**
   * @param cdb - An open ConsciousnessDB instance.
   * @throws ConsciousnessError if cdb is not a valid ConsciousnessDB.
   */
  constructor(cdb: ConsciousnessDB) {
    if (!cdb || typeof cdb.getDb !== 'function') {
      throw new ConsciousnessError(
        'EpisodicMemory: constructor requires a valid ConsciousnessDB instance',
        'consciousness_episodic_invalid_input',
        { received: typeof cdb },
      );
    }
    this.cdb = cdb;
    log.info('EpisodicMemory initialised');
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /**
   * Persist a new episode to the database.
   *
   * @param episode - Fully constructed Episode object.
   * @throws ConsciousnessError on validation or DB failure.
   */
  recordEpisode(episode: Episode): void {
    if (!episode || typeof episode !== 'object') {
      throw new ConsciousnessError(
        'recordEpisode: episode must be a non-null object',
        'consciousness_episodic_invalid_input',
        { received: typeof episode },
      );
    }

    // F105 ZDR: episodic memory is conversation-derived user content. Under
    // zero-data-retention, do not persist a new episode at all (in-memory
    // cognition still ran; nothing is written to consciousness.db).
    if (isZDRBlocked('memory_write')) {
      log.info({ id: episode.id, topic: episode.topic }, 'ZDR active — episode not persisted');
      return;
    }

    // Suppress byte-identical recurrences (heartbeat-replay loops, repeated
    // greetings) within the dedup window. On a hit, strengthen the surviving
    // episode instead of inserting a duplicate row.
    if (dedupEnabled() && typeof episode.summary === 'string' && episode.summary.trim().length > 0) {
      const existingId = this.findRecentDuplicate(episode.summary, episode.startedAt);
      if (existingId) {
        strengthenEpisode(this.cdb.getDb(), existingId, DEDUP_STRENGTHEN_DELTA);
        log.info(
          { duplicateOf: existingId, topic: episode.topic },
          'Recording episode: duplicate suppressed, strengthened existing',
        );
        return;
      }
    }

    log.info({ id: episode.id, topic: episode.topic }, 'Recording episode');
    saveEpisode(this.cdb.getDb(), episode);
    log.info({ id: episode.id }, 'Episode recorded successfully');
  }

  /**
   * Find the most recent episode with a byte-identical summary recorded within
   * the dedup window. Returns its id, or null when no recent duplicate exists.
   *
   * @param summary   - Candidate episode summary.
   * @param startedAt - Candidate episode start timestamp (ISO); falls back to now.
   */
  private findRecentDuplicate(summary: string, startedAt?: string): string | null {
    const anchorMs = startedAt ? Date.parse(startedAt) : Date.now();
    const base = Number.isFinite(anchorMs) ? anchorMs : Date.now();
    const cutoff = new Date(base - dedupWindowMs()).toISOString();
    const row = this.cdb
      .getDb()
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM episodes
         WHERE summary = ? AND started_at >= ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(summary, cutoff);
    return row?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Read — filtered queries
  // -------------------------------------------------------------------------

  /**
   * Query episodes using a structured filter.
   *
   * @param query - Filter and pagination parameters.
   * @returns Matching episodes sorted by started_at DESC.
   */
  query(query: EpisodeQuery): Episode[] {
    if (!query || typeof query !== 'object') {
      throw new ConsciousnessError(
        'query: query must be a non-null object',
        'consciousness_episodic_invalid_input',
        { received: typeof query },
      );
    }

    log.debug({ query }, 'Querying episodes');
    const results = queryEpisodes(this.cdb.getDb(), query);
    log.debug({ count: results.length }, 'Episodes query complete');
    return results;
  }

  /**
   * Return the N most recent episodes by start time.
   *
   * @param count - Number of episodes to return (>= 1).
   */
  getRecent(count: number): Episode[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new ConsciousnessError(
        'getRecent: count must be a positive integer',
        'consciousness_episodic_invalid_input',
        { count },
      );
    }

    log.debug({ count }, 'Getting recent episodes');
    return getRecent(this.cdb.getDb(), count);
  }

  /**
   * Theme 4.3: episodic -> semantic consolidation. Scan the most recent episodes
   * for a dominant recurring topic (>= minSupport raw episodes) and, if found and
   * not already consolidated, fold it into ONE high-significance 'semantic'
   * meta-episode (persisted via recordEpisode). Cheap heuristic; deduped by topic
   * so it does not grow unbounded. Returns the created episode, or null when there
   * is nothing to generalize.
   *
   * @param opts.recentCount - How many recent episodes to scan (default 50).
   * @param opts.minSupport  - Min occurrences before a topic is generalized (default 3).
   */
  consolidateToSemantic(opts: { recentCount?: number; minSupport?: number } = {}): Episode | null {
    const recentCount = opts.recentCount ?? 50;
    const minSupport = opts.minSupport ?? 3;
    const SEMANTIC_TAG = 'semantic';

    const recent = this.getRecent(recentCount);
    // Only generalize raw episodes — never re-consolidate prior generalizations.
    const raw = recent.filter((e) => !(e.tags ?? []).includes(SEMANTIC_TAG));
    if (raw.length < minSupport) return null;

    // Dominant recurring topic.
    const topicCounts = new Map<string, number>();
    for (const e of raw) {
      if (e.topic) topicCounts.set(e.topic, (topicCounts.get(e.topic) ?? 0) + 1);
    }
    let domTopic = '';
    let domCount = 0;
    for (const [t, c] of topicCounts) {
      if (c > domCount) { domTopic = t; domCount = c; }
    }
    if (!domTopic || domCount < minSupport) return null;

    // Dedup: skip if a recent semantic generalization for this topic already exists.
    if (recent.some((e) => (e.tags ?? []).includes(SEMANTIC_TAG) && e.topic === domTopic)) return null;

    // Dominant outcome among that topic's episodes.
    const outcomeCounts = new Map<Episode['outcome'], number>();
    for (const e of raw) {
      if (e.topic === domTopic) outcomeCounts.set(e.outcome, (outcomeCounts.get(e.outcome) ?? 0) + 1);
    }
    let domOutcome: Episode['outcome'] = 'neutral';
    let oc = 0;
    for (const [o, c] of outcomeCounts) {
      if (c > oc) { domOutcome = o; oc = c; }
    }

    const nowIso = new Date().toISOString();
    const episode: Episode = {
      id: genId(),
      summary: `Recurring pattern: "${domTopic}" appears frequently (${domCount} of the last ${raw.length} episodes), mostly ${domOutcome}.`,
      participants: [],
      topic: domTopic,
      tags: [SEMANTIC_TAG, 'consolidated'],
      emotionalValence: { tags: ['calm'], dominantEmotion: 'calm', intensity: 0.2 },
      surpriseLevel: 0,
      outcome: domOutcome,
      significance: 0.9,
      sessionId: null,
      startedAt: nowIso,
      endedAt: nowIso,
      durationMs: 0,
    };

    this.recordEpisode(episode);
    log.info({ topic: domTopic, support: domCount, outcome: domOutcome }, 'consolidateToSemantic: folded episodes into a semantic generalization');
    return episode;
  }

  /**
   * Return the N most significant episodes.
   *
   * @param count - Number of episodes to return (>= 1).
   */
  getBySignificance(count: number): Episode[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new ConsciousnessError(
        'getBySignificance: count must be a positive integer',
        'consciousness_episodic_invalid_input',
        { count },
      );
    }

    log.debug({ count }, 'Getting episodes by significance');
    return getBySignificance(this.cdb.getDb(), count);
  }

  /**
   * Return episodes dominated by a specific emotion, sorted by significance.
   *
   * @param emotion - Emotion tag to filter by.
   * @param count   - Maximum number of results (>= 1).
   */
  getByEmotion(emotion: EmotionTag, count: number): Episode[] {
    if (!emotion || typeof emotion !== 'string') {
      throw new ConsciousnessError(
        'getByEmotion: emotion tag must be a non-empty string',
        'consciousness_episodic_invalid_input',
        { emotion },
      );
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new ConsciousnessError(
        'getByEmotion: count must be a positive integer',
        'consciousness_episodic_invalid_input',
        { count },
      );
    }

    log.debug({ emotion, count }, 'Getting episodes by emotion');
    return getByEmotion(this.cdb.getDb(), emotion, count);
  }

  // -------------------------------------------------------------------------
  // Update — significance adjustment
  // -------------------------------------------------------------------------

  /**
   * Increase the retrieval weight of an episode (capped at 1.0).
   *
   * @param id    - Episode ID.
   * @param delta - Positive increment (e.g. 0.05).
   */
  strengthenEpisode(id: string, delta: number): void {
    if (!id || typeof id !== 'string') {
      throw new ConsciousnessError(
        'strengthenEpisode: id must be a non-empty string',
        'consciousness_episodic_invalid_input',
        { id },
      );
    }
    if (typeof delta !== 'number' || delta <= 0) {
      throw new ConsciousnessError(
        'strengthenEpisode: delta must be a positive number',
        'consciousness_episodic_invalid_input',
        { id, delta },
      );
    }

    log.debug({ id, delta }, 'Strengthening episode');
    strengthenEpisode(this.cdb.getDb(), id, delta);
  }

  /**
   * Decrease the retrieval weight of an episode (floored at 0).
   *
   * @param id    - Episode ID.
   * @param delta - Positive decrement (e.g. 0.05).
   */
  weakenEpisode(id: string, delta: number): void {
    if (!id || typeof id !== 'string') {
      throw new ConsciousnessError(
        'weakenEpisode: id must be a non-empty string',
        'consciousness_episodic_invalid_input',
        { id },
      );
    }
    if (typeof delta !== 'number' || delta <= 0) {
      throw new ConsciousnessError(
        'weakenEpisode: delta must be a positive number',
        'consciousness_episodic_invalid_input',
        { id, delta },
      );
    }

    log.debug({ id, delta }, 'Weakening episode');
    weakenEpisode(this.cdb.getDb(), id, delta);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Free-text search over episode summaries and topics.
   *
   * @param text  - Search string (non-empty).
   * @param limit - Maximum results to return (default 20).
   * @returns Matching episodes sorted by significance DESC.
   */
  search(text: string, limit?: number): Episode[] {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ConsciousnessError(
        'search: text must be a non-empty string',
        'consciousness_episodic_invalid_input',
        { text },
      );
    }

    const resolvedLimit = limit ?? 20;
    if (!Number.isInteger(resolvedLimit) || resolvedLimit < 1) {
      throw new ConsciousnessError(
        'search: limit must be a positive integer',
        'consciousness_episodic_invalid_input',
        { limit },
      );
    }

    log.debug({ text, limit: resolvedLimit }, 'Searching episodes');
    const results = searchEpisodes(this.cdb.getDb(), text, resolvedLimit);
    log.debug({ text, found: results.length }, 'Episode search complete');
    return results;
  }

  /**
   * Decision-time recall (gap #5). search() is a single literal LIKE, so a
   * free-form user message never matches. recall() tokenises the message into
   * salient words, LIKE-searches each, then ranks episodes by how many distinct
   * query words they hit (significance breaks ties). This is what turns episodic
   * memory from write-only into a signal the turn-start prompt can use.
   */
  recall(message: string, limit = 3): Episode[] {
    if (typeof message !== 'string' || !message.trim()) return [];
    const words = Array.from(new Set(
      message.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !RECALL_STOPWORDS.has(w)),
    )).slice(0, 8);
    if (words.length === 0) return [];
    const byId = new Map<string, { ep: Episode; hits: number }>();
    for (const w of words) {
      let found: Episode[] = [];
      try { found = searchEpisodes(this.cdb.getDb(), w, limit * 4); } catch { found = []; }
      for (const e of found) {
        const cur = byId.get(e.id);
        if (cur) cur.hits += 1;
        else byId.set(e.id, { ep: e, hits: 1 });
      }
    }
    return [...byId.values()]
      .sort((a, b) => b.hits - a.hits || b.ep.significance - a.ep.significance)
      .slice(0, limit)
      .map((x) => x.ep);
  }
}

/** Low-signal words dropped before token recall so common verbs don't match everything. */
const RECALL_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'what', 'when', 'where', 'which', 'about',
  'your', 'you', 'the', 'and', 'for', 'are', 'was', 'were', 'can', 'could', 'would',
  'should', 'please', 'need', 'want', 'like', 'just', 'then', 'them', 'they', 'will',
  'into', 'over', 'some', 'more', 'much', 'very', 'here', 'there', 'been', 'does',
]);
