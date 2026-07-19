/**
 * @file tests/telemetry/usage-rollup.test.ts
 * @description BO8 / S7 — pure-function tests for the usage roll-up: per-day
 * and per-type sums on a seeded ledger, window filtering, the ≤1% drift guard,
 * and empty/zero safety.
 */
import { describe, it, expect } from 'vitest';
import {
  rollupUsage,
  windowStartIso,
  type UsageLedgerRow,
} from '../../src/core/telemetry/usage-rollup.js';

// Fixed reference clock so window math is deterministic.
const NOW = new Date('2026-07-19T12:00:00.000Z');

/** ISO ts `d` whole-days before NOW, at noon. */
function daysAgo(d: number): string {
  return new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
}

function row(p: Partial<UsageLedgerRow> & { ts: string }): UsageLedgerRow {
  return {
    caller: 'agent',
    purpose: 'chat',
    route: 'grok',
    tokens_in: 10,
    tokens_out: 5,
    tokens_cached: 2,
    cost_usd: 0.01,
    ...p,
  };
}

describe('windowStartIso', () => {
  it('returns null for "all"', () => {
    expect(windowStartIso('all', NOW)).toBeNull();
  });
  it('counts back 30 / 90 whole days', () => {
    expect(windowStartIso('30d', NOW)).toBe('2026-06-19T12:00:00.000Z');
    expect(windowStartIso('90d', NOW)).toBe('2026-04-20T12:00:00.000Z');
  });
});

describe('rollupUsage — per-day + per-type sums', () => {
  const rows: UsageLedgerRow[] = [
    row({ ts: '2026-07-18T09:00:00.000Z', caller: 'agent',         cost_usd: 0.10, tokens_in: 100, tokens_out: 40 }),
    row({ ts: '2026-07-18T18:00:00.000Z', caller: 'chat',          cost_usd: 0.20, tokens_in: 200, tokens_out: 60 }),
    row({ ts: '2026-07-19T01:00:00.000Z', caller: 'agent',         cost_usd: 0.05, tokens_in: 50,  tokens_out: 10 }),
    row({ ts: '2026-07-19T02:00:00.000Z', caller: 'consciousness', cost_usd: 0.02, tokens_in: 20,  tokens_out: 5  }),
  ];

  it('groups per UTC day with correct totals', () => {
    const r = rollupUsage(rows, { window: 'all', by: 'caller', now: NOW });
    expect(r.days.map((d) => d.date)).toEqual(['2026-07-18', '2026-07-19']);

    const d18 = r.days[0]!;
    expect(d18.calls).toBe(2);
    expect(d18.cost).toBeCloseTo(0.30, 10);
    expect(d18.tokensIn).toBe(300);
    expect(d18.tokensOut).toBe(100);
    expect(d18.tokens).toBe(400);

    const d19 = r.days[1]!;
    expect(d19.calls).toBe(2);
    expect(d19.cost).toBeCloseTo(0.07, 10);
    expect(d19.tokens).toBe(85);
  });

  it('breaks each day down by type (drill-down cells)', () => {
    const r = rollupUsage(rows, { window: 'all', by: 'caller', now: NOW });
    const d18 = r.days[0]!;
    // chat (0.20) sorts before agent (0.10) — cost desc.
    expect(d18.byType.map((c) => c.key)).toEqual(['chat', 'agent']);
    expect(d18.byType[0]!.cost).toBeCloseTo(0.20, 10);
    expect(d18.byType[1]!.tokens).toBe(140);
  });

  it('aggregates window-wide per-type totals, cost desc', () => {
    const r = rollupUsage(rows, { window: 'all', by: 'caller', now: NOW });
    const agent = r.byType.find((c) => c.key === 'agent')!;
    expect(agent.calls).toBe(2);
    expect(agent.cost).toBeCloseTo(0.15, 10);
    expect(agent.tokens).toBe(200);
    // sorted: agent 0.15, chat 0.20 -> chat first
    expect(r.byType[0]!.key).toBe('chat');
  });

  it('supports purpose and route dimensions', () => {
    const mixed: UsageLedgerRow[] = [
      row({ ts: '2026-07-18T09:00:00.000Z', purpose: 'summarize', route: 'grok',  cost_usd: 0.10 }),
      row({ ts: '2026-07-18T10:00:00.000Z', purpose: 'chat',      route: 'claude', cost_usd: 0.20 }),
    ];
    const byPurpose = rollupUsage(mixed, { window: 'all', by: 'purpose', now: NOW });
    expect(byPurpose.byType.map((c) => c.key).sort()).toEqual(['chat', 'summarize']);
    const byRoute = rollupUsage(mixed, { window: 'all', by: 'route', now: NOW });
    expect(byRoute.byType.map((c) => c.key).sort()).toEqual(['claude', 'grok']);
  });
});

describe('rollupUsage — window filtering', () => {
  const rows: UsageLedgerRow[] = [
    row({ ts: daysAgo(5),   cost_usd: 1 }),
    row({ ts: daysAgo(45),  cost_usd: 1 }),
    row({ ts: daysAgo(120), cost_usd: 1 }),
  ];

  it('30d keeps only rows within 30 days', () => {
    const r = rollupUsage(rows, { window: '30d', now: NOW });
    expect(r.totals.calls).toBe(1);
    expect(r.totals.cost).toBeCloseTo(1, 10);
  });
  it('90d keeps rows within 90 days', () => {
    const r = rollupUsage(rows, { window: '90d', now: NOW });
    expect(r.totals.calls).toBe(2);
  });
  it('all keeps every row', () => {
    const r = rollupUsage(rows, { window: 'all', now: NOW });
    expect(r.totals.calls).toBe(3);
  });
});

describe('rollupUsage — drift guard', () => {
  it('reports ~0 drift on a well-formed roll-up', () => {
    const rows: UsageLedgerRow[] = Array.from({ length: 50 }, (_, i) =>
      row({
        ts: daysAgo(i % 25),
        caller: ['agent', 'chat', 'consciousness'][i % 3],
        cost_usd: (i + 1) * 0.0013,
        tokens_in: i * 7,
        tokens_out: i * 3,
      }),
    );
    const r = rollupUsage(rows, { window: 'all', now: NOW });
    expect(r.drift.costDriftPct).toBeLessThanOrEqual(1);
    expect(r.drift.tokenDriftPct).toBeLessThanOrEqual(1);
    expect(r.drift.ok).toBe(true);
    // Roll-up total must equal the direct sum to float epsilon.
    expect(r.drift.rollupCost).toBeCloseTo(r.drift.directCost, 9);
    expect(r.drift.rollupTokens).toBe(r.drift.directTokens);
    // And equal the window totals.
    expect(r.totals.cost).toBeCloseTo(r.drift.directCost, 9);
  });
});

describe('rollupUsage — empty / zero safety', () => {
  it('handles an empty ledger', () => {
    const r = rollupUsage([], { window: '30d', now: NOW });
    expect(r.days).toEqual([]);
    expect(r.byType).toEqual([]);
    expect(r.totals.cost).toBe(0);
    expect(r.drift.ok).toBe(true);
    expect(r.drift.costDriftPct).toBe(0);
  });

  it('treats NULL numerics as 0 and blank type as "unknown"', () => {
    const rows: UsageLedgerRow[] = [
      { ts: '2026-07-19T00:00:00.000Z', caller: null, cost_usd: null, tokens_in: null, tokens_out: null, tokens_cached: null },
      { ts: '2026-07-19T01:00:00.000Z', caller: '   ', cost_usd: 0.5, tokens_in: 10, tokens_out: 0 },
    ];
    const r = rollupUsage(rows, { window: 'all', by: 'caller', now: NOW });
    expect(r.totals.calls).toBe(2);
    expect(r.totals.cost).toBeCloseTo(0.5, 10);
    expect(r.byType.map((c) => c.key)).toEqual(['unknown']);
    expect(r.byType[0]!.calls).toBe(2);
  });

  it('drops rows with a non-ISO / missing ts', () => {
    const rows: UsageLedgerRow[] = [
      { ts: 'not-a-date', cost_usd: 9 },
      { ts: '', cost_usd: 9 },
      row({ ts: '2026-07-19T00:00:00.000Z', cost_usd: 0.01 }),
    ];
    const r = rollupUsage(rows, { window: 'all', now: NOW });
    expect(r.totals.calls).toBe(1);
    expect(r.totals.cost).toBeCloseTo(0.01, 10);
  });
});
