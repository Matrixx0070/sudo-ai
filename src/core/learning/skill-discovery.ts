/**
 * @file skill-discovery.ts
 * @description SkillDiscovery — mine recurring tool-call sequences from audit
 * chain traces to identify learnable patterns.
 *
 * Algorithm:
 *   1. Accept tool call events via recordToolCall(sessionId, toolName, success).
 *   2. Group calls by session into ordered sequences.
 *   3. On mine(), extract N-grams (n=2..4) from each session sequence.
 *   4. Count N-gram occurrences and success rates across all sessions.
 *   5. Return TracePattern[] for N-grams above min_support threshold.
 *
 * Interface contract (spec G1):
 *   recordToolCall(sessionId, toolName, success): void
 *   mine(windowMs?): TracePattern[]
 *
 * Builder 2 calls recordToolCall() after each 'tool-result' event in loop.ts.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { TracePattern } from '../shared/wave10-types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('learning:skill-discovery');

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ToolCallRecord {
  sessionId: string;
  toolName: string;
  success: boolean;
  timestamp: number; // ms since epoch
}

interface NgramAccumulator {
  toolSequence: string[];
  occurrences: { timestamp: number; allSucceeded: boolean }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MIN_SUPPORT = 2;
const NGRAM_MIN_N = 2;
const NGRAM_MAX_N = 4;
/** Default lookback window: 24 hours. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_RECORDS = 10_000;
const RECORDS_EVICT_COUNT = 1_000;

// ---------------------------------------------------------------------------
// SkillDiscovery
// ---------------------------------------------------------------------------

export class SkillDiscovery {
  private readonly records: ToolCallRecord[] = [];
  /** Patterns that have had proposals generated, tracked to avoid duplication. */
  private readonly proposalGenerated = new Set<string>();

  // ---------------------------------------------------------------------------
  // Public API (Builder 2 interface contract)
  // ---------------------------------------------------------------------------

  /**
   * Record a single tool call event.
   *
   * @param sessionId - Session/trace identifier for grouping.
   * @param toolName  - Tool name in "category.action" format.
   * @param success   - Whether this tool call succeeded.
   */
  recordToolCall(sessionId: string, toolName: string, success: boolean): void {
    if (!sessionId || !toolName) return;
    this.records.push({
      sessionId,
      toolName,
      success,
      timestamp: Date.now(),
    });
    if (this.records.length > MAX_RECORDS) {
      this.records.splice(0, RECORDS_EVICT_COUNT);
      log.debug({ evicted: RECORDS_EVICT_COUNT }, 'SkillDiscovery records buffer eviction');
    }
  }

  /**
   * Mine recurring tool-call sequences from recorded events within the window.
   *
   * @param windowMs   - Lookback window in milliseconds (default: 24h).
   * @param minSupport - Minimum occurrences to include a pattern (default: 2).
   * @returns Array of TracePattern objects above the support threshold.
   */
  mine(windowMs = DEFAULT_WINDOW_MS, minSupport = DEFAULT_MIN_SUPPORT): TracePattern[] {
    const cutoff = Date.now() - windowMs;
    const recent = this.records.filter((r) => r.timestamp >= cutoff);

    if (recent.length === 0) {
      log.debug('mine(): no records in window');
      return [];
    }

    // Group by session, preserving order
    const bySession = new Map<string, ToolCallRecord[]>();
    for (const r of recent) {
      if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
      bySession.get(r.sessionId)!.push(r);
    }

    // Build N-gram index
    const ngramIndex = new Map<string, NgramAccumulator>();

    for (const [, sessionRecords] of bySession) {
      const tools = sessionRecords.map((r) => r.toolName);
      const successes = sessionRecords.map((r) => r.success);

      // Extract all N-grams of size NGRAM_MIN_N..NGRAM_MAX_N
      for (let n = NGRAM_MIN_N; n <= NGRAM_MAX_N; n++) {
        for (let i = 0; i <= tools.length - n; i++) {
          const slice = tools.slice(i, i + n);
          const key = slice.join('→');
          const allSucceeded = successes.slice(i, i + n).every(Boolean);
          const lastTimestamp = sessionRecords[i + n - 1]?.timestamp ?? Date.now();

          if (!ngramIndex.has(key)) {
            ngramIndex.set(key, { toolSequence: slice, occurrences: [] });
          }
          ngramIndex.get(key)!.occurrences.push({ timestamp: lastTimestamp, allSucceeded });
        }
      }
    }

    // Build TracePattern[] for entries above min_support
    const patterns: TracePattern[] = [];

    for (const [, accum] of ngramIndex) {
      if (accum.occurrences.length < minSupport) continue;

      const patternId = createHash('sha256')
        .update(accum.toolSequence.join(':'))
        .digest('hex')
        .slice(0, 16);

      const successCount = accum.occurrences.filter((o) => o.allSucceeded).length;
      const successRate = successCount / accum.occurrences.length;

      const timestamps = accum.occurrences.map((o) => o.timestamp);
      const firstTs = Math.min(...timestamps);
      const lastTs = Math.max(...timestamps);

      patterns.push({
        id: patternId,
        toolSequence: accum.toolSequence,
        occurrenceCount: accum.occurrences.length,
        successRate,
        firstSeen: new Date(firstTs).toISOString(),
        lastSeen: new Date(lastTs).toISOString(),
        proposalGenerated: this.proposalGenerated.has(patternId),
      });
    }

    // Sort by occurrence count desc
    patterns.sort((a, b) => b.occurrenceCount - a.occurrenceCount);

    log.info({ patternCount: patterns.length, windowMs, minSupport }, 'mine() complete');
    return patterns;
  }

  /**
   * Mark a pattern as having generated a proposal (so mine() reflects it).
   */
  markProposalGenerated(patternId: string): void {
    this.proposalGenerated.add(patternId);
  }

  /**
   * Clear all recorded tool calls (useful for testing / periodic reset).
   */
  reset(): void {
    this.records.length = 0;
    this.proposalGenerated.clear();
  }

  /**
   * Return current record count (for observability).
   */
  recordCount(): number {
    return this.records.length;
  }
}
