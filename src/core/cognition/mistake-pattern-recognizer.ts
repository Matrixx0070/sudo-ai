/**
 * @file cognition/mistake-pattern-recognizer.ts
 * @description MistakePatternRecognizer — scans the audit_log for repeated
 * mistake signatures, groups them by a normalized SHA-256 hash, and surfaces
 * recurring failure patterns so the system can warn on similar future attempts.
 *
 * Storage: reads `audit_log WHERE action = 'commitment'` — same table used by
 * CommitmentAuditor. The `mistake` field is extracted from each row's
 * `metadata_json` payload (stored by AuditTrail.recordTriple).
 *
 * Pure module — no REST wiring. 6K will wire this into the aggregator.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('cognition:mistake-pattern-recognizer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_MIN_OCCURRENCES = 2;
const LOG_TRUNCATE_LEN = 120;
const SIG_TRUNCATE_LEN = 100;
const NORM_MAX_LEN = 500;
const JACCARD_THRESHOLD = 0.6;
const FIND_SIMILAR_LIMIT = 5;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MistakePattern {
  signatureHash: string;     // sha256(normalize(mistake)).slice(0, 16)
  signature: string;         // first 100 chars of normalized mistake text
  occurrences: number;       // count within the window
  firstSeenAt: string;       // ISO-8601
  lastSeenAt: string;        // ISO-8601
  tags: string[];            // derived from commitment + resource fields
}

export interface PatternAnalysisReport {
  totalMistakes: number;
  uniquePatterns: number;
  recurringPatterns: MistakePattern[];  // occurrences >= minOccurrences
  windowDays: number;
  analyzedAt: string;
}

export interface AnalyzeOptions {
  windowDays?: number;
  minOccurrences?: number;
}

export interface FindSimilarOptions {
  windowDays?: number;
}

// ---------------------------------------------------------------------------
// Duck-typed database interface (6K can inject any compatible DB)
// ---------------------------------------------------------------------------

interface StatementLike<TParams extends unknown[], TResult> {
  all(...params: TParams): TResult[];
}

export interface DatabaseLike {
  prepare<TResult = unknown>(sql: string): StatementLike<unknown[], TResult>;
  exec(sql: string): void;
}

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface RawAuditRow {
  id: string;
  timestamp: string;
  resource: string;
  metadata_json: string | null;
}

interface MistakeMeta {
  mistake?: unknown;
  commitment?: unknown;
  learned?: unknown;
}

interface ParsedMistakeRow {
  id: string;
  timestamp: string;
  resource: string;
  normalizedText: string;
  signatureHash: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Normalization + hashing helpers (module-level for reuse in both methods)
// ---------------------------------------------------------------------------

/**
 * Normalize a mistake string:
 * lowercase → collapse whitespace → strip non-alphanumeric (keep spaces) →
 * trim → truncate to 500 chars → sha256 first 16 hex chars
 */
function normalizeMistake(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .slice(0, NORM_MAX_LEN);
}

function signatureHash(normalizedText: string): string {
  return createHash('sha256').update(normalizedText).digest('hex').slice(0, 16);
}

/**
 * Jaccard similarity between two token sets (split on spaces).
 * Returns 0 if both sets are empty.
 */
function jaccardSimilarity(a: string, b: string): number {
  const tokA = new Set(a.split(' ').filter(t => t.length > 0));
  const tokB = new Set(b.split(' ').filter(t => t.length > 0));
  if (tokA.size === 0 && tokB.size === 0) return 0;

  let intersect = 0;
  for (const t of tokA) {
    if (tokB.has(t)) intersect++;
  }
  const union = tokA.size + tokB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// ---------------------------------------------------------------------------
// Tag derivation
// ---------------------------------------------------------------------------

function deriveTags(meta: MistakeMeta, resource: string): string[] {
  const tags: string[] = [];
  if (typeof meta.commitment === 'string' && meta.commitment.trim().length > 0) {
    tags.push(meta.commitment.slice(0, LOG_TRUNCATE_LEN));
  }
  if (typeof resource === 'string' && resource.trim().length > 0 && resource !== 'system') {
    tags.push(resource);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Empty-result helpers (fail-open)
// ---------------------------------------------------------------------------

function emptyReport(windowDays: number): PatternAnalysisReport {
  return {
    totalMistakes: 0,
    uniquePatterns: 0,
    recurringPatterns: [],
    windowDays,
    analyzedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// MistakePatternRecognizer
// ---------------------------------------------------------------------------

export class MistakePatternRecognizer {
  // Cached prepared statements — re-used across all method calls.
  private readonly _stmtListRecent: StatementLike<[string], RawAuditRow>;
  private readonly _stmtByHash: StatementLike<[string], RawAuditRow>;

  constructor(private readonly db: DatabaseLike) {
    this._stmtListRecent = this.db.prepare<RawAuditRow>(
      `SELECT id, timestamp, resource, metadata_json
       FROM audit_log
       WHERE action = 'commitment'
         AND timestamp >= ?
         AND metadata_json IS NOT NULL`,
    );

    this._stmtByHash = this.db.prepare<RawAuditRow>(
      `SELECT id, timestamp, resource, metadata_json
       FROM audit_log
       WHERE action = 'commitment'
         AND timestamp >= ?
         AND metadata_json IS NOT NULL`,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch and parse recent commitment rows from the DB.
   * Rows without a valid `mistake` string are silently excluded.
   */
  private _fetchAndParse(cutoffIso: string): ParsedMistakeRow[] {
    const raw = this._stmtListRecent.all(cutoffIso);
    const result: ParsedMistakeRow[] = [];

    for (const row of raw) {
      let meta: MistakeMeta;
      try {
        meta = JSON.parse(row.metadata_json ?? '{}') as MistakeMeta;
      } catch {
        log.warn(
          { id: row.id },
          `mistake-pattern-recognizer: failed to parse metadata_json for row, skipping`,
        );
        continue;
      }

      if (typeof meta.mistake !== 'string' || meta.mistake.trim().length === 0) {
        continue;
      }

      const normalized = normalizeMistake(meta.mistake);
      const hash = signatureHash(normalized);
      const tags = deriveTags(meta, row.resource);

      result.push({
        id: row.id,
        timestamp: row.timestamp,
        resource: row.resource,
        normalizedText: normalized,
        signatureHash: hash,
        tags,
      });
    }

    return result;
  }

  /**
   * Compute ISO cutoff string for a given windowDays from now.
   */
  private _cutoffIso(windowDays: number): string {
    return new Date(Date.now() - windowDays * MS_PER_DAY).toISOString();
  }

  /**
   * Group parsed rows by signatureHash, building MistakePattern objects.
   */
  private _groupByHash(rows: ParsedMistakeRow[]): Map<string, MistakePattern> {
    const map = new Map<string, MistakePattern>();

    for (const row of rows) {
      const existing = map.get(row.signatureHash);
      if (existing) {
        existing.occurrences += 1;
        if (row.timestamp < existing.firstSeenAt) {
          existing.firstSeenAt = row.timestamp;
        }
        if (row.timestamp > existing.lastSeenAt) {
          existing.lastSeenAt = row.timestamp;
        }
        // Merge unique tags
        for (const tag of row.tags) {
          if (!existing.tags.includes(tag)) {
            existing.tags.push(tag);
          }
        }
      } else {
        map.set(row.signatureHash, {
          signatureHash: row.signatureHash,
          signature: row.normalizedText.slice(0, SIG_TRUNCATE_LEN),
          occurrences: 1,
          firstSeenAt: row.timestamp,
          lastSeenAt: row.timestamp,
          tags: [...row.tags],
        });
      }
    }

    return map;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Analyze the audit_log for repeated mistake patterns within the rolling
   * window. Returns patterns where occurrences >= minOccurrences.
   * Fails open: DB throw → empty report.
   */
  analyze(opts?: AnalyzeOptions): PatternAnalysisReport {
    const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
    const minOccurrences = opts?.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
    const analyzedAt = new Date().toISOString();

    let rows: ParsedMistakeRow[];
    try {
      rows = this._fetchAndParse(this._cutoffIso(windowDays));
    } catch (err: unknown) {
      log.error(
        { err, event: 'mistake.analyze.error' },
        'mistake-pattern-recognizer: DB query failed; returning empty report (fail-open)',
      );
      return { ...emptyReport(windowDays), analyzedAt };
    }

    const grouped = this._groupByHash(rows);
    const allPatterns = Array.from(grouped.values());
    const recurring = allPatterns.filter(p => p.occurrences >= minOccurrences);

    log.debug(
      {
        event: 'mistake.analyze.done',
        totalMistakes: rows.length,
        uniquePatterns: allPatterns.length,
        recurringPatterns: recurring.length,
        windowDays,
      },
      'mistake-pattern-recognizer: analysis complete',
    );

    return {
      totalMistakes: rows.length,
      uniquePatterns: allPatterns.length,
      recurringPatterns: recurring,
      windowDays,
      analyzedAt,
    };
  }

  /**
   * Find patterns similar to the given mistake text via exact hash match or
   * Jaccard similarity on token sets >= 0.6. Returns top 5 matches.
   * Fails open: DB throw → empty array.
   */
  findSimilar(mistakeText: string, opts?: FindSimilarOptions): MistakePattern[] {
    const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;

    if (typeof mistakeText !== 'string' || mistakeText.trim().length === 0) {
      log.warn(
        { event: 'mistake.find-similar.empty-input' },
        `mistake-pattern-recognizer: empty mistakeText, returning []`,
      );
      return [];
    }

    const queryNormalized = normalizeMistake(mistakeText);
    const queryHash = signatureHash(queryNormalized);

    let rows: ParsedMistakeRow[];
    try {
      rows = this._fetchAndParse(this._cutoffIso(windowDays));
    } catch (err: unknown) {
      log.error(
        { err, event: 'mistake.find-similar.error' },
        'mistake-pattern-recognizer: DB query failed; returning [] (fail-open)',
      );
      return [];
    }

    const grouped = this._groupByHash(rows);

    // Score each pattern by exact hash match (score = 1.0) or Jaccard
    const scored: Array<{ pattern: MistakePattern; score: number }> = [];

    for (const pattern of grouped.values()) {
      if (pattern.signatureHash === queryHash) {
        scored.push({ pattern, score: 1.0 });
        continue;
      }
      const j = jaccardSimilarity(queryNormalized, pattern.signature);
      if (j >= JACCARD_THRESHOLD) {
        scored.push({ pattern, score: j });
      }
    }

    // Sort descending by score, return top 5
    scored.sort((a, b) => b.score - a.score);
    const result = scored.slice(0, FIND_SIMILAR_LIMIT).map(s => s.pattern);

    log.debug(
      {
        event: 'mistake.find-similar.done',
        queryHash,
        queryText: queryNormalized.slice(0, LOG_TRUNCATE_LEN),
        matchCount: result.length,
      },
      'mistake-pattern-recognizer: findSimilar complete',
    );

    return result;
  }
}
