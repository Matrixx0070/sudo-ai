/**
 * Tests for the YouTube quota ledger (GAP-02).
 *
 * The behaviours worth locking in are the ones that protect the publish lane:
 * the Pacific day boundary, the reserve asymmetry, and the search.list denial.
 */

import { describe, it, expect } from 'vitest';
import {
  QuotaLedger,
  QuotaExceededError,
  SearchDeniedError,
  QUOTA_COSTS,
  pacificDay,
} from '../../src/core/youtube/quota-ledger.js';

function ledger(now: () => Date, opts: { dailyLimit?: number; publishReserve?: number } = {}) {
  return new QuotaLedger({ dbPath: ':memory:', now, ...opts });
}

const AT = (iso: string) => () => new Date(iso);

describe('pacificDay', () => {
  it('buckets against Pacific midnight, not UTC midnight', () => {
    // 03:00 UTC on the 2nd is still the 1st in Los Angeles.
    expect(pacificDay(new Date('2026-08-02T03:00:00Z'))).toBe('2026-08-01');
    expect(pacificDay(new Date('2026-08-02T08:00:00Z'))).toBe('2026-08-02');
  });

  it('handles the PST/PDT offset difference', () => {
    // January = PST (UTC-8): 07:00Z is still the previous day.
    expect(pacificDay(new Date('2026-01-15T07:00:00Z'))).toBe('2026-01-14');
    // July = PDT (UTC-7): 07:00Z has already rolled over.
    expect(pacificDay(new Date('2026-07-15T07:00:00Z'))).toBe('2026-07-15');
  });
});

describe('QuotaLedger accounting', () => {
  it('starts empty and reports the default allowance', () => {
    const q = ledger(AT('2026-08-01T12:00:00Z'));
    expect(q.status()).toMatchObject({ limit: 10_000, spent: 0, remaining: 10_000, publishReserve: 1600 });
    // Reads see the allowance minus the publish reserve.
    expect(q.status().available).toBe(8_400);
    q.close();
  });

  it('accumulates units per method and reports a breakdown', () => {
    const q = ledger(AT('2026-08-01T12:00:00Z'));
    q.spend('videos.list', 3);
    q.spend('videos.list', 2);
    q.spend('videos.update');
    expect(q.spent()).toBe(5 * QUOTA_COSTS['videos.list'] + QUOTA_COSTS['videos.update']);
    expect(q.breakdown()).toEqual([
      { method: 'videos.update', units: 50, calls: 1 },
      { method: 'videos.list', units: 5, calls: 5 },
    ]);
    q.close();
  });

  it('resets at the Pacific day boundary', () => {
    let clock = new Date('2026-08-01T12:00:00Z');
    const q = ledger(() => clock);
    q.spend('videos.insert');
    expect(q.spent()).toBe(1600);

    // Same UTC-day-plus-one, but before Pacific midnight — still the same bucket.
    clock = new Date('2026-08-02T05:00:00Z');
    expect(q.spent()).toBe(1600);

    // Past Pacific midnight — fresh budget.
    clock = new Date('2026-08-02T08:00:00Z');
    expect(q.spent()).toBe(0);
    q.close();
  });
});

describe('publish reserve', () => {
  it('stops discretionary reads from starving the upload lane', () => {
    const q = ledger(AT('2026-08-01T12:00:00Z'), { dailyLimit: 2000, publishReserve: 1600 });

    // 400 units are available to reads; videos.list costs 1.
    expect(q.canAfford('videos.list', 400)).toBe(true);
    expect(q.canAfford('videos.list', 401)).toBe(false);

    q.spend('videos.list', 400);

    // Reads are now shut out...
    expect(q.canAfford('videos.list')).toBe(false);
    expect(() => q.spend('videos.list')).toThrow(QuotaExceededError);

    // ...but the upload can still draw on its reserve. This is the whole point.
    expect(q.canAfford('videos.insert')).toBe(true);
    q.spend('videos.insert');
    expect(q.spent()).toBe(2000);
    q.close();
  });

  it('refuses an upload once the reserve itself is gone', () => {
    const q = ledger(AT('2026-08-01T12:00:00Z'), { dailyLimit: 2000, publishReserve: 1600 });
    q.spend('videos.insert');
    expect(q.canAfford('videos.insert')).toBe(false);
    expect(() => q.spend('videos.insert')).toThrow(QuotaExceededError);
    q.close();
  });

  it('names the method and remaining budget on the error', () => {
    const q = ledger(AT('2026-08-01T12:00:00Z'), { dailyLimit: 100, publishReserve: 0 });
    try {
      q.spend('videos.insert');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      expect((err as QuotaExceededError).method).toBe('videos.insert');
      expect((err as Error).message).toMatch(/Pacific/);
    }
    q.close();
  });
});

describe('search.list denial', () => {
  it('refuses search.list by default and says what to use instead', () => {
    const q = ledger(AT('2026-08-01T12:00:00Z'));
    expect(() => q.spend('search.list')).toThrow(SearchDeniedError);
    expect(() => q.spend('search.list')).toThrow(/RSS feed|playlistItems/);
    // Nothing was recorded for a denied call.
    expect(q.spent()).toBe(0);
    q.close();
  });

  it('allows it with an explicit override, and charges the real 100 units', () => {
    const q = ledger(AT('2026-08-01T12:00:00Z'));
    q.spend('search.list', 1, { allowSearch: true });
    expect(q.spent()).toBe(100);
    q.close();
  });

  it('would exhaust the day in 100 calls — the reason it is denied', () => {
    const q = ledger(AT('2026-08-01T12:00:00Z'), { publishReserve: 0 });
    for (let i = 0; i < 100; i++) q.spend('search.list', 1, { allowSearch: true });
    expect(q.spent()).toBe(10_000);
    expect(q.canAfford('videos.insert')).toBe(false);
    q.close();
  });
});
