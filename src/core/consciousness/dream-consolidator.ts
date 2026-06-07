/**
 * @file dream-consolidator.ts
 * @description DreamConsolidator — background memory consolidation during idle periods.
 *
 * Complements the existing AutoDream 4-phase cycle with a lighter-weight
 * consolidator that can run opportunistically during idle cycles rather than
 * requiring a full dream cycle. Handles three core operations:
 *
 *   1. consolidate()   — run a background consolidation pass (merge similar
 *                        memories, detect patterns, prune stale entries)
 *   2. compactMemories() — merge near-duplicate memories and prune stale ones
 *   3. refreshContext()  — re-read files that have been modified since last read
 *
 * Design goals:
 *   - Idempotent: safe to call repeatedly; work is only done when needed
 *   - Lightweight: designed for idle-cycle invocation, not heavy batch jobs
 *   - Observable: every DreamSession is recorded with precise metrics
 */

import { createLogger } from '../shared/logger.js';
import { genId } from '../shared/utils.js';
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const log = createLogger('consciousness:dream-consolidator');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single memory entry managed by the consolidator. */
export interface MemoryEntry {
  /** Unique identifier. */
  id: string;
  /** Natural-language content. */
  content: string;
  /** Semantic topic or category tag. */
  topic: string;
  /** ISO-8601 timestamp when this memory was created. */
  createdAt: string;
  /** ISO-8601 timestamp when this memory was last accessed or reinforced. */
  lastAccessedAt: string;
  /** Access count — how many times this memory has been retrieved. */
  accessCount: number;
  /** Similarity hash for near-duplicate detection. */
  contentHash: string;
}

/** Result of a single background consolidation session. */
export interface DreamSession {
  /** Unique session identifier. */
  id: string;
  /** ISO-8601 timestamp when consolidation started. */
  startTime: string;
  /** ISO-8601 timestamp when consolidation ended. */
  endTime: string;
  /** Number of memory entries processed during this session. */
  memoriesProcessed: number;
  /** Number of patterns discovered during this session. */
  patternsFound: number;
  /** Estimated token savings from compaction. */
  tokensSaved: number;
}

/** A pattern discovered during consolidation. */
export interface ConsolidationPattern {
  /** Pattern identifier. */
  id: string;
  /** Human-readable pattern description. */
  description: string;
  /** IDs of memory entries that exhibit this pattern. */
  memoryIds: string[];
  /** Confidence in this pattern (0-1). */
  confidence: number;
  /** ISO-8601 timestamp when pattern was found. */
  foundAt: string;
}

/** Configuration for the DreamConsolidator. */
export interface DreamConsolidatorConfig {
  /** Directory where memory data is stored. */
  dataDir: string;
  /** Maximum age in days before a memory with accessCount 0 is pruned. */
  staleThresholdDays: number;
  /** Minimum similarity (0-1) for two memories to be considered near-duplicates. */
  similarityThreshold: number;
  /** Maximum number of memories to process per consolidation pass. */
  batchSize: number;
  /** Path to the file that tracks modification timestamps for refreshContext. */
  fileTimestampStore: string;
}

const DEFAULT_CONFIG: Readonly<DreamConsolidatorConfig> = {
  dataDir: 'data/consciousness',
  staleThresholdDays: 30,
  similarityThreshold: 0.85,
  batchSize: 100,
  fileTimestampStore: 'data/consciousness/file-timestamps.json',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Simple Jaccard-like similarity on word sets. */
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Very rough token estimate: 1 token ~ 4 chars. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Read the memory store from disk, returning an empty array if missing. */
function loadMemories(dataDir: string): MemoryEntry[] {
  const memPath = join(dataDir, 'memories.json');
  if (!existsSync(memPath)) return [];
  try {
    return JSON.parse(readFileSync(memPath, 'utf-8')) as MemoryEntry[];
  } catch {
    log.warn({ path: memPath }, 'Corrupt memories.json — starting fresh');
    return [];
  }
}

/** Persist memory entries to disk. */
function saveMemories(dataDir: string, memories: MemoryEntry[]): void {
  const memPath = join(dataDir, 'memories.json');
  try {
    writeFileSync(memPath, JSON.stringify(memories, null, 2), 'utf-8');
  } catch (err) {
    log.error({ path: memPath, err }, 'Failed to write memories.json');
  }
}

/** Read the pattern store from disk. */
function loadPatterns(dataDir: string): ConsolidationPattern[] {
  const patPath = join(dataDir, 'patterns.json');
  if (!existsSync(patPath)) return [];
  try {
    return JSON.parse(readFileSync(patPath, 'utf-8')) as ConsolidationPattern[];
  } catch {
    return [];
  }
}

/** Persist patterns to disk. */
function savePatterns(dataDir: string, patterns: ConsolidationPattern[]): void {
  const patPath = join(dataDir, 'patterns.json');
  try {
    writeFileSync(patPath, JSON.stringify(patterns, null, 2), 'utf-8');
  } catch (err) {
    log.error({ path: patPath, err }, 'Failed to write patterns.json');
  }
}

/** Load the file-timestamp store (maps file path -> last known mtime). */
function loadFileTimestamps(storePath: string): Record<string, string> {
  if (!existsSync(storePath)) return {};
  try {
    return JSON.parse(readFileSync(storePath, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Persist file timestamps. */
function saveFileTimestamps(storePath: string, ts: Record<string, string>): void {
  try {
    writeFileSync(storePath, JSON.stringify(ts, null, 2), 'utf-8');
  } catch (err) {
    log.error({ path: storePath, err }, 'Failed to write file timestamps');
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    try {
      const { mkdirSync } = require('fs');
      mkdirSync(dir, { recursive: true });
    } catch {
      // Non-fatal; callers handle missing data gracefully.
    }
  }
}

// ---------------------------------------------------------------------------
// DreamConsolidator
// ---------------------------------------------------------------------------

/**
 * Lightweight background consolidator that runs during idle cycles.
 *
 * Unlike the full AutoDream 4-phase cycle (which requires a brain call and
 * produces a full MEMORY.md section), this consolidator operates purely on
 * structured memory entries — merging near-duplicates, pruning stale data,
 * and detecting recurring patterns — without invoking an LLM.
 */
export class DreamConsolidator {
  private readonly config: Readonly<DreamConsolidatorConfig>;
  private sessionCount = 0;

  constructor(config?: Partial<DreamConsolidatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    ensureDir(this.config.dataDir);
    log.info(
      { staleDays: this.config.staleThresholdDays, batchSize: this.config.batchSize },
      'DreamConsolidator initialized',
    );
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run a background consolidation pass.
   * Compacts memories, detects patterns, and returns a DreamSession summary.
   */
  async consolidate(): Promise<DreamSession> {
    const sessionId = genId();
    const startTime = new Date().toISOString();
    log.info({ sessionId }, 'Consolidation session started');

    const memories = loadMemories(this.config.dataDir);
    const originalCount = memories.length;
    const originalTokens = memories.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    // Phase 1: compact memories (merge + prune)
    const compacted = this.compactMemories(memories);
    const afterTokens = compacted.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    saveMemories(this.config.dataDir, compacted);

    // Phase 2: detect patterns in surviving memories.
    // detectPatterns() produces a complete snapshot of all current patterns
    // (one per qualifying topic) over the surviving memories, so we replace the
    // stored set rather than appending — appending would regenerate equivalent
    // patterns every pass (fresh id/foundAt each time) and grow unbounded.
    const newPatterns = this.detectPatterns(compacted);
    savePatterns(this.config.dataDir, newPatterns);

    const endTime = new Date().toISOString();
    const session: DreamSession = {
      id: sessionId,
      startTime,
      endTime,
      memoriesProcessed: originalCount,
      patternsFound: newPatterns.length,
      tokensSaved: originalTokens - afterTokens,
    };

    this.sessionCount++;
    log.info(
      {
        sessionId,
        memoriesProcessed: session.memoriesProcessed,
        memoriesAfter: compacted.length,
        patternsFound: session.patternsFound,
        tokensSaved: session.tokensSaved,
      },
      'Consolidation session completed',
    );

    return session;
  }

  /**
   * Merge similar (near-duplicate) memories and prune stale entries.
   * Returns a new array; does not mutate the input.
   */
  compactMemories(memories?: MemoryEntry[]): MemoryEntry[] {
    const input = memories ?? loadMemories(this.config.dataDir);
    let result = [...input];
    const now = Date.now();
    const staleCutoffMs = this.config.staleThresholdDays * 24 * 60 * 60 * 1000;

    // Step 1: prune stale entries (never accessed and older than threshold)
    result = result.filter((m) => {
      const age = now - new Date(m.lastAccessedAt).getTime();
      if (m.accessCount === 0 && age > staleCutoffMs) {
        log.debug({ id: m.id, topic: m.topic }, 'Pruning stale memory');
        return false;
      }
      return true;
    });

    // Step 2: merge near-duplicates
    const merged: MemoryEntry[] = [];
    const consumed = new Set<string>();

    for (let i = 0; i < result.length; i++) {
      const a = result[i];
      if (consumed.has(a.id)) continue;

      let bestMatch: MemoryEntry | null = null;
      let bestSim = 0;

      for (let j = i + 1; j < result.length; j++) {
        const b = result[j];
        if (consumed.has(b.id)) continue;

        // Only merge within same topic
        if (a.topic !== b.topic) continue;

        const sim = textSimilarity(a.content, b.content);
        if (sim > bestSim) {
          bestSim = sim;
          bestMatch = b;
        }
      }

      if (bestMatch && bestSim >= this.config.similarityThreshold) {
        // Merge: keep the longer content, sum access counts
        const mergedContent = a.content.length >= bestMatch.content.length
          ? a.content
          : bestMatch.content;

        merged.push({
          id: genId(),
          content: mergedContent,
          topic: a.topic,
          createdAt: a.createdAt,
          lastAccessedAt: new Date().toISOString(),
          accessCount: a.accessCount + bestMatch.accessCount,
          contentHash: a.contentHash,
        });

        consumed.add(a.id);
        consumed.add(bestMatch.id);

        log.debug(
          { idA: a.id, idB: bestMatch.id, similarity: bestSim.toFixed(2) },
          'Merged near-duplicate memories',
        );
      } else {
        merged.push(a);
      }
    }

    return merged;
  }

  /**
   * Re-read files that have been modified since the last known mtime.
   * Returns an array of file paths that were refreshed.
   */
  refreshContext(filePaths: string[]): string[] {
    const timestamps = loadFileTimestamps(this.config.fileTimestampStore);
    const refreshed: string[] = [];

    for (const filePath of filePaths) {
      if (!existsSync(filePath)) continue;

      try {
        const currentMtime = statSync(filePath).mtime.toISOString();
        const knownMtime = timestamps[filePath];

        if (knownMtime !== currentMtime) {
          // File has been modified — read it (in a real system, this feeds
          // the context manager; here we record that we detected the change)
          try {
            readFileSync(filePath, 'utf-8');
          } catch {
            log.debug({ filePath }, 'Cannot read modified file');
            continue;
          }

          timestamps[filePath] = currentMtime;
          refreshed.push(filePath);

          log.debug({ filePath, oldMtime: knownMtime ?? 'never', newMtime: currentMtime }, 'File refreshed');
        }
      } catch {
        log.debug({ filePath }, 'Cannot stat file for refresh check');
      }
    }

    saveFileTimestamps(this.config.fileTimestampStore, timestamps);
    return refreshed;
  }

  /**
   * Detect recurring patterns across memories within the same topic.
   * Groups memories by topic and reports topics with 3+ entries as patterns.
   */
  detectPatterns(memories: MemoryEntry[]): ConsolidationPattern[] {
    const topicGroups = new Map<string, MemoryEntry[]>();
    for (const m of memories) {
      const group = topicGroups.get(m.topic) ?? [];
      group.push(m);
      topicGroups.set(m.topic, group);
    }

    const patterns: ConsolidationPattern[] = [];
    for (const [topic, entries] of topicGroups) {
      if (entries.length < 3) continue;

      // Compute average similarity within group
      let totalSim = 0;
      let pairCount = 0;
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          totalSim += textSimilarity(entries[i].content, entries[j].content);
          pairCount++;
        }
      }
      const avgSim = pairCount > 0 ? totalSim / pairCount : 0;

      patterns.push({
        id: genId(),
        description: `Recurring topic: ${topic} (${entries.length} memories, avg similarity ${(avgSim * 100).toFixed(1)}%)`,
        memoryIds: entries.map((e) => e.id),
        confidence: Math.min(avgSim, 1),
        foundAt: new Date().toISOString(),
      });
    }

    return patterns;
  }

  /**
   * Return operational statistics.
   */
  getStats(): { totalSessions: number; memoryCount: number; patternCount: number } {
    const memories = loadMemories(this.config.dataDir);
    const patterns = loadPatterns(this.config.dataDir);
    return {
      totalSessions: this.sessionCount,
      memoryCount: memories.length,
      patternCount: patterns.length,
    };
  }

  /**
   * Load all memories from disk (useful for inspection / debugging).
   */
  getMemories(): MemoryEntry[] {
    return loadMemories(this.config.dataDir);
  }

  /**
   * Load all patterns from disk.
   */
  getPatterns(): ConsolidationPattern[] {
    return loadPatterns(this.config.dataDir);
  }

  /**
   * Add a memory entry and persist it.
   */
  addMemory(entry: Omit<MemoryEntry, 'id'>): MemoryEntry {
    const memories = loadMemories(this.config.dataDir);
    const newEntry: MemoryEntry = { ...entry, id: genId() };
    memories.push(newEntry);
    saveMemories(this.config.dataDir, memories);
    return newEntry;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<DreamConsolidatorConfig> {
    return this.config;
  }
}