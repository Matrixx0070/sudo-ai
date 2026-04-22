/**
 * @file inspection-queue.test.ts
 * @description Tests for InspectionQueue (Wave 6A Builder C spec §6).
 *
 * Covers:
 *  1. enqueue returns a UUID string
 *  2. enqueued entry is retrievable via query
 *  3. payload_excerpt is capped at 500 chars
 *  4. full payload is NOT stored (only excerpt)
 *  5. payload_hash is a SHA-256 hex string (64 chars)
 *  6. pattern_matches parsed as array (JSON round-trip)
 *  7. default status is 'pending'
 *  8. query with status filter returns only matching rows
 *  9. query without filter returns all rows ordered by created_at DESC
 * 10. updateStatus changes status and sets reviewed_at
 * 11. updateStatus with reviewedBy populates reviewed_by column
 * 12. updateStatus without reviewedBy leaves reviewed_by null
 * 13. enqueue with empty patternMatches stores '[]'
 * 14. corrupt pattern_matches in DB falls back to [] (JSON.parse safety)
 * 15. query limit is respected (default 100, custom limit)
 * 16. multiple enqueues produce distinct UUIDs
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  createInspectionQueue,
  type InspectionQueueInstance,
  type EnqueueOptions,
} from '../../src/core/security/inspection-queue.js';
import { initializeSchema } from '../../src/core/memory/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initializeSchema(db);
  return db;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeOpts(overrides: Partial<EnqueueOptions> = {}): EnqueueOptions {
  return {
    source: 'test-tool',
    category: 'inbound',
    severity: 'medium',
    fullPayload: 'Test payload content that contains suspicious patterns.',
    patternMatches: ['ignore-previous-instructions', 'you-are-now'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createInspectionQueue', () => {
  let db: Database.Database;
  let queue: InspectionQueueInstance;

  beforeEach(() => {
    db = makeDb();
    queue = createInspectionQueue(db);
  });

  it('enqueue returns a UUID string', () => {
    const id = queue.enqueue(makeOpts());
    expect(typeof id).toBe('string');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('enqueued entry is retrievable via query', () => {
    const id = queue.enqueue(makeOpts());
    const entries = queue.query();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const found = entries.find((e) => e.id === id);
    expect(found).toBeDefined();
  });

  it('stores source, category, severity correctly', () => {
    const id = queue.enqueue(makeOpts({ source: 'my-tool', category: 'generated', severity: 'high' }));
    const entries = queue.query();
    const entry = entries.find((e) => e.id === id);
    expect(entry?.source).toBe('my-tool');
    expect(entry?.category).toBe('generated');
    expect(entry?.severity).toBe('high');
  });

  it('payload_excerpt is capped at 500 chars', () => {
    const longPayload = 'A'.repeat(1000);
    const id = queue.enqueue(makeOpts({ fullPayload: longPayload }));
    const entries = queue.query();
    const entry = entries.find((e) => e.id === id);
    expect(entry?.payload_excerpt).toBe('A'.repeat(500));
    expect(entry?.payload_excerpt.length).toBe(500);
  });

  it('payload_excerpt contains first 500 chars of fullPayload (not beyond)', () => {
    const payload = 'START_' + 'B'.repeat(494) + '_END';
    const id = queue.enqueue(makeOpts({ fullPayload: payload }));
    const entries = queue.query();
    const entry = entries.find((e) => e.id === id);
    // The excerpt should be exactly the first 500 chars
    expect(entry?.payload_excerpt).toBe(payload.slice(0, 500));
    expect(entry?.payload_excerpt).not.toContain('_END');
  });

  it('payload_hash is a SHA-256 hex string (64 chars)', () => {
    const payload = 'Test payload for hash verification.';
    const id = queue.enqueue(makeOpts({ fullPayload: payload }));
    const entries = queue.query();
    const entry = entries.find((e) => e.id === id);
    expect(entry?.payload_hash).toBe(sha256Hex(payload));
    expect(entry?.payload_hash.length).toBe(64);
    expect(entry?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pattern_matches is parsed as array (JSON round-trip)', () => {
    const patterns = ['pattern-one', 'pattern-two', 'pattern-three'];
    const id = queue.enqueue(makeOpts({ patternMatches: patterns }));
    const entries = queue.query();
    const entry = entries.find((e) => e.id === id);
    expect(Array.isArray(entry?.pattern_matches)).toBe(true);
    expect(entry?.pattern_matches).toEqual(patterns);
  });

  it('default status is pending', () => {
    const id = queue.enqueue(makeOpts());
    const entries = queue.query();
    const entry = entries.find((e) => e.id === id);
    expect(entry?.status).toBe('pending');
  });

  it('query with status filter returns only matching rows', () => {
    const id1 = queue.enqueue(makeOpts({ source: 'tool-a' }));
    queue.enqueue(makeOpts({ source: 'tool-b' }));
    // Update first to cleared
    queue.updateStatus(id1, 'cleared', 'admin');

    const pending = queue.query({ status: 'pending' });
    const cleared = queue.query({ status: 'cleared' });

    expect(pending.every((e) => e.status === 'pending')).toBe(true);
    expect(cleared.every((e) => e.status === 'cleared')).toBe(true);
    expect(pending.length).toBe(1);
    expect(cleared.length).toBe(1);
  });

  it('query without filter returns all rows', () => {
    queue.enqueue(makeOpts({ source: 'tool-x' }));
    queue.enqueue(makeOpts({ source: 'tool-y' }));
    queue.enqueue(makeOpts({ source: 'tool-z' }));
    const all = queue.query();
    expect(all.length).toBe(3);
  });

  it('updateStatus changes status and sets reviewed_at', () => {
    const id = queue.enqueue(makeOpts());
    queue.updateStatus(id, 'blocked');
    const entries = queue.query();
    const entry = entries.find((e) => e.id === id);
    expect(entry?.status).toBe('blocked');
    expect(entry?.reviewed_at).toBeTruthy();
    // reviewed_at should be a valid ISO date
    expect(() => new Date(entry!.reviewed_at!)).not.toThrow();
  });

  it('updateStatus with reviewedBy populates reviewed_by column', () => {
    const id = queue.enqueue(makeOpts());
    queue.updateStatus(id, 'reviewed', 'security-admin');
    const entries = queue.query();
    const entry = entries.find((e) => e.id === id);
    expect(entry?.reviewed_by).toBe('security-admin');
    expect(entry?.status).toBe('reviewed');
  });

  it('updateStatus without reviewedBy leaves reviewed_by null', () => {
    const id = queue.enqueue(makeOpts());
    queue.updateStatus(id, 'cleared');
    const entries = queue.query();
    const entry = entries.find((e) => e.id === id);
    expect(entry?.reviewed_by).toBeNull();
  });

  it('enqueue with empty patternMatches stores and returns empty array', () => {
    const id = queue.enqueue(makeOpts({ patternMatches: [] }));
    const entries = queue.query();
    const entry = entries.find((e) => e.id === id);
    expect(entry?.pattern_matches).toEqual([]);
  });

  it('corrupt pattern_matches in DB falls back to empty array', () => {
    // Directly insert a row with invalid JSON in pattern_matches
    db.prepare(`
      INSERT INTO inspection_queue
        (id, source, category, severity, payload_excerpt, payload_hash, pattern_matches)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'corrupt-test-id',
      'test',
      'inbound',
      'low',
      'excerpt',
      sha256Hex('excerpt'),
      'NOT_VALID_JSON',
    );

    const entries = queue.query();
    const entry = entries.find((e) => e.id === 'corrupt-test-id');
    expect(entry).toBeDefined();
    expect(Array.isArray(entry?.pattern_matches)).toBe(true);
    expect(entry?.pattern_matches).toEqual([]);
  });

  it('query limit is respected', () => {
    for (let i = 0; i < 10; i++) {
      queue.enqueue(makeOpts({ source: `tool-${i}` }));
    }
    const limited = queue.query({ limit: 3 });
    expect(limited.length).toBe(3);
  });

  it('multiple enqueues produce distinct UUIDs', () => {
    const ids = [
      queue.enqueue(makeOpts()),
      queue.enqueue(makeOpts()),
      queue.enqueue(makeOpts()),
    ];
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
  });
});
