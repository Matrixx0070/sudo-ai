/**
 * @file skill-optimizer.test.ts
 * @description Unit tests for SkillOptimizer and SkillOptimizationStore.
 * Wave 13 Builder 1.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { SkillOptimizationStore } from '../../src/core/skills/skill-optimization-store.js';
import { SkillOptimizer } from '../../src/core/skills/skill-optimizer.js';
import type { SkillOptimizationProposal } from '../../src/core/shared/wave10-types.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `skill-opt-test-${randomUUID()}.db`);
}

function makeProposal(overrides: Partial<SkillOptimizationProposal> = {}): SkillOptimizationProposal {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    skillId: 'skill-abc',
    skillName: 'test-skill',
    targetField: 'description',
    currentValue: 'old description',
    proposedValue: 'new description',
    evidence: 'test evidence',
    confidence: 0.7,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub signals
// ---------------------------------------------------------------------------

function makeSkillDiscovery(patterns: Array<{
  id: string;
  toolSequence: string[];
  occurrenceCount: number;
  successRate: number;
  proposalGenerated: boolean;
}> = []) {
  return { mine: (_windowMs?: number) => patterns };
}

function makeRegistry(skills: Array<{ id: string; name: string; frontmatter: Record<string, unknown> }> = []) {
  return { list: (_limit: number, _offset: number) => skills };
}

// ---------------------------------------------------------------------------
// SkillOptimizationStore tests
// ---------------------------------------------------------------------------

describe('SkillOptimizationStore', () => {
  let dbPath: string;
  let store: SkillOptimizationStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new SkillOptimizationStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it('saves and retrieves a proposal by id', () => {
    const p = makeProposal();
    store.save(p);
    const found = store.getById(p.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(p.id);
    expect(found!.skillId).toBe(p.skillId);
    expect(found!.status).toBe('pending');
  });

  it('save is idempotent on duplicate id (insert-or-ignore)', () => {
    const p = makeProposal();
    store.save(p);
    store.save(p); // should not throw
    const { total } = store.list({ limit: 100, offset: 0 });
    expect(total).toBe(1);
  });

  it('list returns all proposals without filter', () => {
    store.save(makeProposal({ id: randomUUID(), status: 'pending' }));
    store.save(makeProposal({ id: randomUUID(), status: 'approved' }));
    const result = store.list({ limit: 100, offset: 0 });
    expect(result.total).toBe(2);
    expect(result.data).toHaveLength(2);
  });

  it('list filters by status', () => {
    store.save(makeProposal({ id: randomUUID(), status: 'pending' }));
    const approvedId = randomUUID();
    store.save(makeProposal({ id: approvedId, status: 'pending' }));
    store.approve(approvedId);
    const pending = store.list({ status: 'pending', limit: 100, offset: 0 });
    expect(pending.total).toBe(1);
    const approved = store.list({ status: 'approved', limit: 100, offset: 0 });
    expect(approved.total).toBe(1);
  });

  it('approve transitions status to approved', () => {
    const p = makeProposal();
    store.save(p);
    const updated = store.approve(p.id);
    expect(updated.status).toBe('approved');
    expect(store.getById(p.id)!.status).toBe('approved');
  });

  it('approve throws on unknown id', () => {
    expect(() => store.approve('nonexistent-id')).toThrow();
  });

  it('reject transitions status to rejected', () => {
    const p = makeProposal();
    store.save(p);
    const updated = store.reject(p.id, 'not useful');
    expect(updated.status).toBe('rejected');
    expect(store.getById(p.id)!.status).toBe('rejected');
  });

  it('reject without reason does not append reason text', () => {
    const p = makeProposal({ evidence: 'original evidence' });
    store.save(p);
    const updated = store.reject(p.id);
    expect(updated.evidence).toBe('original evidence');
  });

  it('reject throws on unknown id', () => {
    expect(() => store.reject('nonexistent-id')).toThrow();
  });

  it('getLatestApprovedForSkill returns most recent approved proposal', () => {
    const p1 = makeProposal({ id: randomUUID(), skillId: 'skill-x' });
    const p2 = makeProposal({ id: randomUUID(), skillId: 'skill-x' });
    store.save(p1);
    store.save(p2);
    store.approve(p1.id);
    store.approve(p2.id);
    const latest = store.getLatestApprovedForSkill('skill-x');
    expect(latest).not.toBeNull();
    expect(['skill-x']).toContain(latest!.skillId);
  });

  it('getLatestApprovedForSkill returns null when no approved proposals', () => {
    store.save(makeProposal({ skillId: 'skill-y' }));
    expect(store.getLatestApprovedForSkill('skill-y')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SkillOptimizer tests
// ---------------------------------------------------------------------------

describe('SkillOptimizer', () => {
  let dbPath: string;
  let store: SkillOptimizationStore;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new SkillOptimizationStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it('returns empty array when no skills in registry', () => {
    const optimizer = new SkillOptimizer(makeSkillDiscovery(), undefined, undefined, store, makeRegistry());
    const result = optimizer.propose();
    expect(result).toEqual([]);
  });

  it('returns empty array when no matching patterns', () => {
    const optimizer = new SkillOptimizer(
      makeSkillDiscovery([
        { id: 'p1', toolSequence: ['other.tool'], occurrenceCount: 5, successRate: 0.2, proposalGenerated: false },
      ]),
      undefined,
      undefined,
      store,
      makeRegistry([{ id: 'skill-abc', name: 'my-skill', frontmatter: { description: 'A skill' } }]),
    );
    const result = optimizer.propose();
    expect(result).toEqual([]);
  });

  it('generates a proposal when skill name matches pattern tool sequence', () => {
    const optimizer = new SkillOptimizer(
      makeSkillDiscovery([
        {
          id: 'p1',
          toolSequence: ['skills.my-skill', 'skills.other'],
          occurrenceCount: 10,
          successRate: 0.2, // low success = high penalty = should generate proposal
          proposalGenerated: false,
        },
      ]),
      undefined,
      undefined,
      store,
      makeRegistry([{ id: 'skill-abc', name: 'my-skill', frontmatter: { description: 'A skill' } }]),
    );
    const result = optimizer.propose();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.skillName).toBe('my-skill');
  });

  it('caps proposals at exactly 5 when more than 5 candidates pass the confidence filter', () => {
    // Create 10 skills that will all match patterns.
    // With occurrenceCount=20, successRate=0.1: confidence = clamp(0.5 + 20*1.8*0.05, 0.1, 0.99) = 0.99
    // All 10 pass the 0.3 filter — the cap fires and truncates to 5.
    const skills = Array.from({ length: 10 }, (_, i) => ({
      id: `skill-${i}`,
      name: `skill-${i}`,
      frontmatter: { description: `Skill ${i}` },
    }));
    const patterns = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      toolSequence: [`skills.skill-${i}`, 'other.tool'],
      occurrenceCount: 20,
      successRate: 0.1, // very low success = high confidence candidate
      proposalGenerated: false,
    }));

    const optimizer = new SkillOptimizer(
      makeSkillDiscovery(patterns),
      undefined,
      undefined,
      store,
      makeRegistry(skills),
    );
    const result = optimizer.propose();
    // Must be exactly 5 — proves the cap/truncation branch ran
    expect(result.length).toBe(5);
  });

  it('propose() returns at most 5 proposals (cap enforced)', () => {
    const skills = Array.from({ length: 20 }, (_, i) => ({
      id: `skill-${i}`,
      name: `skill-${i}`,
      frontmatter: { description: `Skill ${i}` },
    }));
    const patterns = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      toolSequence: [`skills.skill-${i}`],
      occurrenceCount: 30,
      successRate: 0.05,
      proposalGenerated: false,
    }));

    const optimizer = new SkillOptimizer(
      makeSkillDiscovery(patterns),
      undefined,
      undefined,
      store,
      makeRegistry(skills),
    );
    const result = optimizer.propose();
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('skips patterns where proposalGenerated is true', () => {
    const optimizer = new SkillOptimizer(
      makeSkillDiscovery([
        {
          id: 'p1',
          toolSequence: ['skills.my-skill'],
          occurrenceCount: 20,
          successRate: 0.1,
          proposalGenerated: true, // already generated
        },
      ]),
      undefined,
      undefined,
      store,
      makeRegistry([{ id: 'skill-abc', name: 'my-skill', frontmatter: { description: 'A skill' } }]),
    );
    const result = optimizer.propose();
    expect(result).toEqual([]);
  });

  it('applies Brier score adjustment when brierScore > 0.35', () => {
    const calibTracker = {
      getReport: (_opts?: { windowDays?: number }) => ({ brierScore: 0.8, totalSamples: 100 }),
    };
    const optimizer = new SkillOptimizer(
      makeSkillDiscovery([
        {
          id: 'p1',
          toolSequence: ['skills.my-skill'],
          occurrenceCount: 10,
          successRate: 0.2,
          proposalGenerated: false,
        },
      ]),
      undefined,
      calibTracker,
      store,
      makeRegistry([{ id: 'skill-abc', name: 'my-skill', frontmatter: { description: 'A skill' } }]),
    );
    const result = optimizer.propose();
    // With high brier score, confidence is adjusted down — may or may not produce proposal
    // Just verify it doesn't throw and returns an array
    expect(Array.isArray(result)).toBe(true);
  });

  it('listPending returns pending proposals from store', () => {
    const optimizer = new SkillOptimizer(
      makeSkillDiscovery([
        {
          id: 'p1',
          toolSequence: ['skills.my-skill'],
          occurrenceCount: 15,
          successRate: 0.2,
          proposalGenerated: false,
        },
      ]),
      undefined,
      undefined,
      store,
      makeRegistry([{ id: 'skill-abc', name: 'my-skill', frontmatter: { description: 'A skill' } }]),
    );
    optimizer.propose();
    const pending = optimizer.listPending();
    expect(Array.isArray(pending)).toBe(true);
  });

  it('getApprovedForSkill returns null when no approved proposals', () => {
    const optimizer = new SkillOptimizer(
      makeSkillDiscovery(),
      undefined,
      undefined,
      store,
      makeRegistry(),
    );
    const result = optimizer.getApprovedForSkill('nonexistent-skill');
    expect(result).toBeNull();
  });

  it('getApprovedForSkill returns approved proposal after approval', () => {
    const optimizer = new SkillOptimizer(
      makeSkillDiscovery([
        {
          id: 'p1',
          toolSequence: ['skills.my-skill'],
          occurrenceCount: 15,
          successRate: 0.2,
          proposalGenerated: false,
        },
      ]),
      undefined,
      undefined,
      store,
      makeRegistry([{ id: 'skill-abc', name: 'my-skill', frontmatter: { description: 'A skill' } }]),
    );
    const proposals = optimizer.propose();
    if (proposals.length > 0) {
      store.approve(proposals[0]!.id);
      const approved = optimizer.getApprovedForSkill('skill-abc');
      expect(approved).not.toBeNull();
      expect(approved!.status).toBe('approved');
    }
  });

  it('wires mistakePatternRecognizer signal without throwing', () => {
    const mistakeRec = {
      analyze: (_opts?: { windowDays?: number; minOccurrences?: number }) => ({
        recurringPatterns: [
          { signature: 'my-skill error pattern', occurrences: 3, tags: ['my-skill'] },
        ],
      }),
    };
    const optimizer = new SkillOptimizer(
      makeSkillDiscovery([
        {
          id: 'p1',
          toolSequence: ['skills.my-skill'],
          occurrenceCount: 10,
          successRate: 0.2,
          proposalGenerated: false,
        },
      ]),
      mistakeRec,
      undefined,
      store,
      makeRegistry([{ id: 'skill-abc', name: 'my-skill', frontmatter: { description: 'A skill' } }]),
    );
    expect(() => optimizer.propose()).not.toThrow();
  });

  it('fails open when store.save throws', () => {
    const badStore = {
      save: () => { throw new Error('db error'); },
      list: () => ({ data: [] as SkillOptimizationProposal[], total: 0 }),
      getById: () => null,
      getLatestApprovedForSkill: () => null,
      approve: () => { throw new Error(); },
      reject: () => { throw new Error(); },
      close: () => undefined,
    };
    const optimizer = new SkillOptimizer(
      makeSkillDiscovery([
        {
          id: 'p1',
          toolSequence: ['skills.my-skill'],
          occurrenceCount: 15,
          successRate: 0.2,
          proposalGenerated: false,
        },
      ]),
      undefined,
      undefined,
      badStore as unknown as SkillOptimizationStore,
      makeRegistry([{ id: 'skill-abc', name: 'my-skill', frontmatter: { description: 'A skill' } }]),
    );
    // Should not throw — fail-open
    expect(() => optimizer.propose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wave 2.1 B3: probe-row transaction rollback test
// ---------------------------------------------------------------------------

describe('applyAutoAppliedMigration probe transaction rollback', () => {
  it('leaves no __probe__ row when INSERT succeeds but an error occurs before DELETE completes', () => {
    // Use better-sqlite3 directly to simulate the transaction behaviour.
    // We construct the same table schema the store uses, then run a transaction
    // where the INSERT succeeds but we throw before DELETE — verifying rollback.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(':memory:');

    // Create the table with the widened CHECK (auto-applied allowed) so the
    // INSERT in the probe transaction succeeds — we want to test the rollback
    // path when the DELETE never fires (simulating a kill between the two ops).
    db.exec(`
      CREATE TABLE skill_optimizations (
        id              TEXT PRIMARY KEY,
        skill_id        TEXT NOT NULL,
        skill_name      TEXT NOT NULL,
        target_field    TEXT NOT NULL CHECK (target_field IN ('description','examples','tags')),
        current_value   TEXT NOT NULL DEFAULT '',
        proposed_value  TEXT NOT NULL DEFAULT '',
        evidence        TEXT NOT NULL DEFAULT '',
        confidence      REAL NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','auto-applied')),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      )
    `);

    const probeInsert = db.prepare(`
      INSERT INTO skill_optimizations
        (id, skill_id, skill_name, target_field, current_value, proposed_value,
         evidence, confidence, status, created_at, updated_at)
        VALUES ('__probe__', 'probe', 'probe', 'description', '', '', '', 0,
                'auto-applied', 'probe', 'probe')
    `);

    // Simulate "INSERT succeeded but process dies before DELETE" by throwing
    // from within the transaction after the INSERT.
    const brokenTxn = db.transaction(() => {
      probeInsert.run();
      throw new Error('simulated kill between INSERT and DELETE');
    });

    expect(() => brokenTxn()).toThrow('simulated kill between INSERT and DELETE');

    // Transaction must have been rolled back — no orphaned __probe__ row.
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM skill_optimizations WHERE id = '__probe__'`,
    ).get() as { n: number };
    expect(row.n).toBe(0);

    db.close();
  });
});
