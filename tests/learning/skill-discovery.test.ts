/**
 * Tests for skill-discovery.ts — N-gram mining of tool call sequences.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillDiscovery } from '../../src/core/learning/skill-discovery.js';

describe('SkillDiscovery', () => {
  let discovery: SkillDiscovery;

  beforeEach(() => {
    discovery = new SkillDiscovery();
  });

  // ---------------------------------------------------------------------------
  // recordToolCall
  // ---------------------------------------------------------------------------

  describe('recordToolCall()', () => {
    it('records tool calls without throwing', () => {
      expect(() => {
        discovery.recordToolCall('session-1', 'coder.read-file', true);
      }).not.toThrow();
    });

    it('increments record count', () => {
      expect(discovery.recordCount()).toBe(0);
      discovery.recordToolCall('s1', 'tool.a', true);
      discovery.recordToolCall('s1', 'tool.b', true);
      expect(discovery.recordCount()).toBe(2);
    });

    it('ignores empty sessionId', () => {
      discovery.recordToolCall('', 'tool.a', true);
      expect(discovery.recordCount()).toBe(0);
    });

    it('ignores empty toolName', () => {
      discovery.recordToolCall('s1', '', true);
      expect(discovery.recordCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // mine() — basic functionality
  // ---------------------------------------------------------------------------

  describe('mine()', () => {
    it('returns empty array when no records', () => {
      const patterns = discovery.mine();
      expect(patterns).toHaveLength(0);
    });

    it('returns empty array when sequences appear only once (below min_support=2)', () => {
      discovery.recordToolCall('s1', 'tool.a', true);
      discovery.recordToolCall('s1', 'tool.b', true);
      const patterns = discovery.mine(undefined, 2);
      expect(patterns).toHaveLength(0);
    });

    it('finds bigram appearing in 2 sessions', () => {
      // Session 1: A → B
      discovery.recordToolCall('s1', 'coder.read-file', true);
      discovery.recordToolCall('s1', 'coder.write-file', true);
      // Session 2: A → B
      discovery.recordToolCall('s2', 'coder.read-file', true);
      discovery.recordToolCall('s2', 'coder.write-file', true);

      const patterns = discovery.mine(undefined, 2);
      const bigram = patterns.find(
        (p) => JSON.stringify(p.toolSequence) === JSON.stringify(['coder.read-file', 'coder.write-file']),
      );
      expect(bigram).toBeDefined();
      expect(bigram!.occurrenceCount).toBeGreaterThanOrEqual(2);
    });

    it('calculates success rate correctly', () => {
      // 2 sessions: 1 all-success, 1 mixed
      discovery.recordToolCall('s1', 'tool.x', true);
      discovery.recordToolCall('s1', 'tool.y', true); // success

      discovery.recordToolCall('s2', 'tool.x', true);
      discovery.recordToolCall('s2', 'tool.y', false); // fail

      const patterns = discovery.mine(undefined, 2);
      const pattern = patterns.find(
        (p) => JSON.stringify(p.toolSequence) === JSON.stringify(['tool.x', 'tool.y']),
      );
      expect(pattern).toBeDefined();
      // 1 out of 2 occurrences had all succeeded
      expect(pattern!.successRate).toBe(0.5);
    });

    it('finds trigrams when they appear >= min_support times', () => {
      for (let i = 0; i < 3; i++) {
        const sid = `session-${i}`;
        discovery.recordToolCall(sid, 'tool.a', true);
        discovery.recordToolCall(sid, 'tool.b', true);
        discovery.recordToolCall(sid, 'tool.c', true);
      }

      const patterns = discovery.mine(undefined, 2);
      const trigram = patterns.find(
        (p) => p.toolSequence.length === 3 &&
          p.toolSequence[0] === 'tool.a' &&
          p.toolSequence[2] === 'tool.c',
      );
      expect(trigram).toBeDefined();
    });

    it('returns patterns with firstSeen and lastSeen ISO-8601 timestamps', () => {
      discovery.recordToolCall('s1', 'x', true);
      discovery.recordToolCall('s1', 'y', true);
      discovery.recordToolCall('s2', 'x', true);
      discovery.recordToolCall('s2', 'y', true);

      const patterns = discovery.mine(undefined, 2);
      expect(patterns.length).toBeGreaterThan(0);
      for (const p of patterns) {
        expect(p.firstSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(p.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });

    it('pattern IDs are stable hash of tool sequence', () => {
      discovery.recordToolCall('s1', 'a', true);
      discovery.recordToolCall('s1', 'b', true);
      discovery.recordToolCall('s2', 'a', true);
      discovery.recordToolCall('s2', 'b', true);

      const p1 = discovery.mine(undefined, 2);

      discovery.reset();
      discovery.recordToolCall('s3', 'a', true);
      discovery.recordToolCall('s3', 'b', true);
      discovery.recordToolCall('s4', 'a', true);
      discovery.recordToolCall('s4', 'b', true);

      const p2 = discovery.mine(undefined, 2);

      const p1Pattern = p1.find((p) => JSON.stringify(p.toolSequence) === JSON.stringify(['a', 'b']));
      const p2Pattern = p2.find((p) => JSON.stringify(p.toolSequence) === JSON.stringify(['a', 'b']));
      expect(p1Pattern).toBeDefined();
      expect(p2Pattern).toBeDefined();
      expect(p1Pattern!.id).toBe(p2Pattern!.id);
    });

    it('respects min_support threshold', () => {
      // Pattern appears 3 times — should show at min_support=2 but not min_support=5
      for (let i = 0; i < 3; i++) {
        discovery.recordToolCall(`s${i}`, 'p', true);
        discovery.recordToolCall(`s${i}`, 'q', true);
      }

      const patterns2 = discovery.mine(undefined, 2);
      const patterns5 = discovery.mine(undefined, 5);

      expect(patterns2.length).toBeGreaterThan(0);
      expect(patterns5).toHaveLength(0);
    });

    it('sorts patterns by occurrence count descending', () => {
      // Pattern 1: 4 occurrences
      for (let i = 0; i < 4; i++) {
        discovery.recordToolCall(`s${i}`, 'a', true);
        discovery.recordToolCall(`s${i}`, 'b', true);
      }
      // Pattern 2: 2 occurrences (different tools)
      for (let i = 10; i < 12; i++) {
        discovery.recordToolCall(`s${i}`, 'x', true);
        discovery.recordToolCall(`s${i}`, 'y', true);
      }

      const patterns = discovery.mine(undefined, 2);
      for (let i = 1; i < patterns.length; i++) {
        expect(patterns[i - 1]!.occurrenceCount).toBeGreaterThanOrEqual(patterns[i]!.occurrenceCount);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // markProposalGenerated / proposalGenerated flag
  // ---------------------------------------------------------------------------

  describe('markProposalGenerated()', () => {
    it('marks a pattern as having a proposal', () => {
      discovery.recordToolCall('s1', 'a', true);
      discovery.recordToolCall('s1', 'b', true);
      discovery.recordToolCall('s2', 'a', true);
      discovery.recordToolCall('s2', 'b', true);

      const patterns = discovery.mine(undefined, 2);
      const patternId = patterns[0]!.id;

      expect(patterns[0]!.proposalGenerated).toBe(false);

      discovery.markProposalGenerated(patternId);

      const updated = discovery.mine(undefined, 2);
      const p = updated.find((p) => p.id === patternId);
      expect(p!.proposalGenerated).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // reset()
  // ---------------------------------------------------------------------------

  describe('reset()', () => {
    it('clears all records', () => {
      discovery.recordToolCall('s1', 'a', true);
      discovery.reset();
      expect(discovery.recordCount()).toBe(0);
      expect(discovery.mine()).toHaveLength(0);
    });

    it('clears proposal generated marks', () => {
      discovery.recordToolCall('s1', 'a', true);
      discovery.recordToolCall('s1', 'b', true);
      discovery.recordToolCall('s2', 'a', true);
      discovery.recordToolCall('s2', 'b', true);

      const patterns = discovery.mine(undefined, 2);
      discovery.markProposalGenerated(patterns[0]!.id);
      discovery.reset();

      // Re-populate same pattern
      discovery.recordToolCall('s3', 'a', true);
      discovery.recordToolCall('s3', 'b', true);
      discovery.recordToolCall('s4', 'a', true);
      discovery.recordToolCall('s4', 'b', true);

      const newPatterns = discovery.mine(undefined, 2);
      const samePat = newPatterns.find((p) => p.id === patterns[0]!.id);
      expect(samePat?.proposalGenerated).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Array cap / eviction (CAP-SD-1 through CAP-SD-4)
  // ---------------------------------------------------------------------------

  describe('records buffer cap', () => {
    // CAP-SD-1: recordCount() stays <= MAX_RECORDS after MAX_RECORDS+1 pushes
    // MAX_RECORDS = 10_000; pushing 10_001 triggers eviction of 1_000 oldest
    it('CAP-SD-1: recordCount() stays <= MAX_RECORDS after MAX_RECORDS+1 pushes', () => {
      const PUSH_COUNT = 10_001; // one over the cap
      for (let i = 0; i < PUSH_COUNT; i++) {
        discovery.recordToolCall(`s${i}`, 'tool.x', true);
      }
      expect(discovery.recordCount()).toBeLessThanOrEqual(10_000);
    });

    // CAP-SD-2: eviction removes exactly RECORDS_EVICT_COUNT oldest entries
    // After pushing 10_001 entries the array should be 10_001 - 1_000 = 9_001
    it('CAP-SD-2: eviction removes exactly RECORDS_EVICT_COUNT oldest entries', () => {
      const PUSH_COUNT = 10_001;
      for (let i = 0; i < PUSH_COUNT; i++) {
        discovery.recordToolCall(`s${i}`, 'tool.x', true);
      }
      // 10_001 pushed, 1_000 evicted on the splice → 9_001 remain
      expect(discovery.recordCount()).toBe(9_001);
    });

    // CAP-SD-3: records added after eviction are retained (newest entries not lost)
    it('CAP-SD-3: records added after eviction are retained', () => {
      // Fill to just above the cap to trigger one eviction
      for (let i = 0; i < 10_001; i++) {
        discovery.recordToolCall(`pre${i}`, 'tool.pre', true);
      }
      const countAfterEviction = discovery.recordCount(); // 9_001
      // Add 5 more records after eviction
      for (let j = 0; j < 5; j++) {
        discovery.recordToolCall(`post${j}`, 'tool.post', true);
      }
      expect(discovery.recordCount()).toBe(countAfterEviction + 5);
    });

    // CAP-SD-4: no eviction fires below MAX_RECORDS
    it('CAP-SD-4: no eviction fires below MAX_RECORDS', () => {
      const SMALL_COUNT = 50;
      for (let i = 0; i < SMALL_COUNT; i++) {
        discovery.recordToolCall(`s${i}`, 'tool.y', true);
      }
      expect(discovery.recordCount()).toBe(SMALL_COUNT);
    });
  });
});
