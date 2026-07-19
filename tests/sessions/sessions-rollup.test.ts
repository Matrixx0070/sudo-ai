/**
 * @file tests/sessions/sessions-rollup.test.ts
 * @description BO9 / S8 — unit tests for the pure sessions roll-up (the list
 * builder that feeds the inline dashboard's sessions table). Mocks a session
 * store as plain records and asserts:
 *  - context-fill % (used / window), from explicit tokens AND char estimate;
 *  - sorting (updated / tokens / messages / key);
 *  - kind grouping (groups ordered by tokens desc, rows preserved);
 *  - state filtering (active / archived / all);
 *  - window-wide totals + average fill.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSessionRows,
  estimateTokens,
  DEFAULT_CONTEXT_WINDOW,
  type SessionUsageRecord,
} from '../../src/core/sessions/sessions-rollup.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');

function rec(over: Partial<SessionUsageRecord> & { id: string }): SessionUsageRecord {
  return {
    kind: 'web',
    peerId: 'peer',
    state: 'active',
    createdAt: '2026-07-19T10:00:00.000Z',
    updatedAt: '2026-07-19T11:00:00.000Z',
    ...over,
  } as SessionUsageRecord;
}

describe('buildSessionRows — context fill', () => {
  it('computes % from explicit usedTokens against the default window', () => {
    const out = buildSessionRows([rec({ id: 'a', usedTokens: 250_000 })], { now: NOW });
    const row = out.rows[0]!;
    expect(row.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW); // 1_000_000
    expect(row.usedTokens).toBe(250_000);
    expect(row.contextPct).toBe(25); // 250k / 1M
    expect(row.tokensEstimated).toBe(false);
  });

  it('estimates tokens from chars (~4 chars/token) when usedTokens absent', () => {
    const out = buildSessionRows([rec({ id: 'a', chars: 40_000 })], { now: NOW, contextWindow: 100_000 });
    const row = out.rows[0]!;
    expect(row.usedTokens).toBe(estimateTokens(40_000)); // 10_000
    expect(row.usedTokens).toBe(10_000);
    expect(row.contextPct).toBe(10); // 10k / 100k
    expect(row.tokensEstimated).toBe(true);
  });

  it('respects a per-record contextWindow override', () => {
    const out = buildSessionRows([rec({ id: 'a', usedTokens: 500, contextWindow: 1000 })], { now: NOW });
    expect(out.rows[0]!.contextPct).toBe(50);
    expect(out.rows[0]!.contextWindow).toBe(1000);
  });

  it('builds the display key as kind:peerId', () => {
    const out = buildSessionRows([rec({ id: 'x', kind: 'telegram', peerId: 'u42' })], { now: NOW });
    expect(out.rows[0]!.key).toBe('telegram:u42');
  });
});

describe('buildSessionRows — sorting', () => {
  const base: SessionUsageRecord[] = [
    rec({ id: 'old', usedTokens: 100, messageCount: 2, updatedAt: '2026-07-19T09:00:00.000Z', peerId: 'c' }),
    rec({ id: 'new', usedTokens: 10, messageCount: 50, updatedAt: '2026-07-19T11:59:00.000Z', peerId: 'a' }),
    rec({ id: 'mid', usedTokens: 900, messageCount: 9, updatedAt: '2026-07-19T10:30:00.000Z', peerId: 'b' }),
  ];

  it('sorts by updated (most recent first) by default', () => {
    const out = buildSessionRows(base, { now: NOW });
    expect(out.rows.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('sorts by tokens desc', () => {
    const out = buildSessionRows(base, { now: NOW, sort: 'tokens' });
    expect(out.rows.map((r) => r.id)).toEqual(['mid', 'old', 'new']);
  });

  it('sorts by messages desc', () => {
    const out = buildSessionRows(base, { now: NOW, sort: 'messages' });
    expect(out.rows.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('sorts by key asc', () => {
    const out = buildSessionRows(base, { now: NOW, sort: 'key' });
    // keys: web:a (new), web:b (mid), web:c (old)
    expect(out.rows.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('buildSessionRows — kind grouping', () => {
  it('groups by kind, ordered by total tokens desc', () => {
    const recs = [
      rec({ id: 'w1', kind: 'web', usedTokens: 100, peerId: 'p1' }),
      rec({ id: 't1', kind: 'telegram', usedTokens: 500, peerId: 'p2' }),
      rec({ id: 'w2', kind: 'web', usedTokens: 50, peerId: 'p3' }),
    ];
    const out = buildSessionRows(recs, { now: NOW, groupBy: 'kind' });
    expect(out.groupBy).toBe('kind');
    expect(out.groups.map((g) => g.kind)).toEqual(['telegram', 'web']); // 500 vs 150
    const web = out.groups.find((g) => g.kind === 'web')!;
    expect(web.count).toBe(2);
    expect(web.usedTokens).toBe(150);
    expect(web.rows.map((r) => r.id).sort()).toEqual(['w1', 'w2']);
  });

  it('leaves groups empty when groupBy is none', () => {
    const out = buildSessionRows([rec({ id: 'a' })], { now: NOW });
    expect(out.groups).toEqual([]);
  });
});

describe('buildSessionRows — state filter + totals', () => {
  const recs = [
    rec({ id: 'a', state: 'active', usedTokens: 100, peerId: 'p1' }),
    rec({ id: 'b', state: 'archived', usedTokens: 200, peerId: 'p2' }),
    rec({ id: 'c', state: 'active', usedTokens: 300, peerId: 'p3' }),
  ];

  it('defaults to active only', () => {
    const out = buildSessionRows(recs, { now: NOW });
    expect(out.rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(out.totals.count).toBe(2);
    expect(out.totals.active).toBe(2);
    expect(out.totals.archived).toBe(0);
  });

  it('archived only', () => {
    const out = buildSessionRows(recs, { now: NOW, stateFilter: 'archived' });
    expect(out.rows.map((r) => r.id)).toEqual(['b']);
  });

  it('all + totals + average fill', () => {
    const out = buildSessionRows(recs, { now: NOW, stateFilter: 'all', contextWindow: 1000 });
    expect(out.totals.count).toBe(3);
    expect(out.totals.usedTokens).toBe(600);
    // pcts: 10, 20, 30 -> avg 20
    expect(out.totals.avgContextPct).toBe(20);
  });

  it('empty input yields a well-formed zeroed roll-up', () => {
    const out = buildSessionRows([], { now: NOW });
    expect(out.count).toBe(0);
    expect(out.totals.avgContextPct).toBe(0);
    expect(out.rows).toEqual([]);
  });
});
