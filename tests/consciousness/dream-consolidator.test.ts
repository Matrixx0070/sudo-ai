/**
 * @file dream-consolidator.test.ts
 * @description Tests for DreamConsolidator — memory consolidation, compaction, and context refresh.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  DreamConsolidator,
  type MemoryEntry,
  type DreamSession,
  type DreamConsolidatorConfig,
} from '../../src/core/consciousness/dream-consolidator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function makeConfig(): DreamConsolidatorConfig {
  return {
    dataDir: join(tempDir, 'consciousness'),
    staleThresholdDays: 30,
    similarityThreshold: 0.6, // lowered for testing
    batchSize: 100,
    fileTimestampStore: join(tempDir, 'file-timestamps.json'),
  };
}

function makeMemory(overrides: Partial<MemoryEntry> & { content: string; topic: string }): MemoryEntry {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2, 8)}`,
    content: overrides.content,
    topic: overrides.topic,
    createdAt: overrides.createdAt ?? now,
    lastAccessedAt: overrides.lastAccessedAt ?? now,
    accessCount: overrides.accessCount ?? 1,
    contentHash: overrides.contentHash ?? 'abc123',
  };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('DreamConsolidator', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dream-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  it('initializes with default config', () => {
    const consolidator = new DreamConsolidator({ dataDir: join(tempDir, 'data') });
    const config = consolidator.getConfig();
    expect(config.staleThresholdDays).toBe(30);
    expect(config.similarityThreshold).toBe(0.85);
    expect(config.batchSize).toBe(100);
  });

  it('overrides config values', () => {
    const consolidator = new DreamConsolidator({
      dataDir: join(tempDir, 'data'),
      staleThresholdDays: 7,
      similarityThreshold: 0.5,
    });
    const config = consolidator.getConfig();
    expect(config.staleThresholdDays).toBe(7);
    expect(config.similarityThreshold).toBe(0.5);
  });

  // -----------------------------------------------------------------------
  // addMemory / getMemories
  // -----------------------------------------------------------------------

  it('adds and retrieves memory entries', () => {
    const consolidator = new DreamConsolidator(makeConfig());
    const entry = consolidator.addMemory({
      content: 'Learned about cron scheduling patterns',
      topic: 'scheduling',
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 1,
      contentHash: 'hash1',
    });

    expect(entry.id).toBeTruthy();
    const memories = consolidator.getMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe('Learned about cron scheduling patterns');
    expect(memories[0].topic).toBe('scheduling');
  });

  // -----------------------------------------------------------------------
  // compactMemories — pruning stale
  // -----------------------------------------------------------------------

  it('prunes stale memories with zero access count', () => {
    const config = makeConfig();
    const consolidator = new DreamConsolidator(config);

    const stale = makeMemory({
      content: 'Old stale memory',
      topic: 'legacy',
      accessCount: 0,
      lastAccessedAt: daysAgo(45), // older than 30-day threshold
    });

    const fresh = makeMemory({
      content: 'Recent active memory',
      topic: 'active',
      accessCount: 3,
      lastAccessedAt: daysAgo(1),
    });

    const zeroAccessRecent = makeMemory({
      content: 'Zero access but recent',
      topic: 'recent',
      accessCount: 0,
      lastAccessedAt: daysAgo(5), // within 30-day threshold
    });

    const result = consolidator.compactMemories([stale, fresh, zeroAccessRecent]);

    // Stale memory should be pruned; fresh and recent-zero-access should remain
    expect(result.find((m) => m.content === 'Old stale memory')).toBeUndefined();
    expect(result.find((m) => m.content === 'Recent active memory')).toBeDefined();
    expect(result.find((m) => m.content === 'Zero access but recent')).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // compactMemories — merging near-duplicates
  // -----------------------------------------------------------------------

  it('merges near-duplicate memories within the same topic', () => {
    const config = makeConfig();
    const consolidator = new DreamConsolidator(config);

    const memA = makeMemory({
      content: 'The cron scheduler runs every five minutes to check for pending tasks',
      topic: 'scheduling',
      accessCount: 2,
    });

    const memB = makeMemory({
      content: 'The cron scheduler runs every five minutes to check for pending tasks and fires them',
      topic: 'scheduling',
      accessCount: 3,
    });

    const unrelated = makeMemory({
      content: 'Completely different topic about file storage',
      topic: 'storage',
      accessCount: 1,
    });

    const result = consolidator.compactMemories([memA, memB, unrelated]);

    // The two scheduling memories should be merged into one
    const schedulingMems = result.filter((m) => m.topic === 'scheduling');
    expect(schedulingMems).toHaveLength(1);
    expect(schedulingMems[0].accessCount).toBe(5); // 2 + 3

    // The unrelated memory should survive untouched
    const storageMems = result.filter((m) => m.topic === 'storage');
    expect(storageMems).toHaveLength(1);
  });

  it('does not merge memories from different topics even if similar', () => {
    const config = makeConfig();
    const consolidator = new DreamConsolidator(config);

    const memA = makeMemory({
      content: 'The system checks for pending tasks every five minutes',
      topic: 'scheduling',
      accessCount: 1,
    });

    const memB = makeMemory({
      content: 'The system checks for pending tasks every five minutes',
      topic: 'monitoring',
      accessCount: 1,
    });

    const result = consolidator.compactMemories([memA, memB]);
    expect(result).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // consolidate (full pass)
  // -----------------------------------------------------------------------

  it('runs a full consolidation session and returns a DreamSession', async () => {
    const consolidator = new DreamConsolidator(makeConfig());

    // Add some memories
    consolidator.addMemory({
      content: 'First memory about testing',
      topic: 'testing',
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      accessCount: 1,
      contentHash: 'h1',
    });

    const session = await consolidator.consolidate();

    expect(session.id).toBeTruthy();
    expect(session.startTime).toBeTruthy();
    expect(session.endTime).toBeTruthy();
    expect(session.memoriesProcessed).toBeGreaterThanOrEqual(1);
    expect(typeof session.patternsFound).toBe('number');
    expect(typeof session.tokensSaved).toBe('number');
  });

  // -----------------------------------------------------------------------
  // refreshContext
  // -----------------------------------------------------------------------

  it('detects modified files and returns their paths', () => {
    const config = makeConfig();
    const consolidator = new DreamConsolidator(config);

    // Create a test file
    const testFile = join(tempDir, 'test-file.txt');
    writeFileSync(testFile, 'original content', 'utf-8');

    // First call: file is new (never tracked), should be reported as refreshed
    const firstResult = consolidator.refreshContext([testFile]);
    expect(firstResult).toContain(testFile);

    // Second call without modifying the file: should NOT be refreshed
    const secondResult = consolidator.refreshContext([testFile]);
    expect(secondResult).toHaveLength(0);

    // Modify the file and force a distinct mtime to avoid race conditions on fast filesystems
    writeFileSync(testFile, 'modified content', 'utf-8');
    const { utimesSync } = require('node:fs');
    const future = new Date(Date.now() + 2000);
    utimesSync(testFile, future, future);

    // Third call: should detect modification
    const thirdResult = consolidator.refreshContext([testFile]);
    expect(thirdResult).toContain(testFile);
  });

  it('skips non-existent files in refreshContext', () => {
    const consolidator = new DreamConsolidator(makeConfig());
    const result = consolidator.refreshContext(['/nonexistent/file.txt']);
    expect(result).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // detectPatterns
  // -----------------------------------------------------------------------

  it('detects recurring topic patterns with 3+ entries', () => {
    const consolidator = new DreamConsolidator(makeConfig());

    const memories: MemoryEntry[] = [
      makeMemory({ content: 'Pattern item A about cron', topic: 'cron' }),
      makeMemory({ content: 'Pattern item B about cron', topic: 'cron' }),
      makeMemory({ content: 'Pattern item C about cron', topic: 'cron' }),
      makeMemory({ content: 'Isolated item', topic: 'oneoff' }),
    ];

    const patterns = consolidator.detectPatterns(memories);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].description).toContain('cron');
    expect(patterns[0].memoryIds).toHaveLength(3);
  });

  it('does not report patterns for topics with fewer than 3 entries', () => {
    const consolidator = new DreamConsolidator(makeConfig());

    const memories: MemoryEntry[] = [
      makeMemory({ content: 'Only two items about cron', topic: 'cron' }),
      makeMemory({ content: 'Second cron item', topic: 'cron' }),
    ];

    const patterns = consolidator.detectPatterns(memories);
    expect(patterns).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // getStats
  // -----------------------------------------------------------------------

  it('tracks session count in getStats', async () => {
    const consolidator = new DreamConsolidator(makeConfig());

    const stats0 = consolidator.getStats();
    expect(stats0.totalSessions).toBe(0);

    await consolidator.consolidate();
    const stats1 = consolidator.getStats();
    expect(stats1.totalSessions).toBe(1);

    await consolidator.consolidate();
    const stats2 = consolidator.getStats();
    expect(stats2.totalSessions).toBe(2);
  });
});