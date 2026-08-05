/**
 * @file quota-ledger.ts
 * @description Daily YouTube Data API quota accounting with reservations.
 *
 * Closes GAP-02. The Data API gives each Google Cloud project 10,000 units per
 * day, resetting at midnight *Pacific*. `videos.insert` costs 1,600 of them and
 * `search.list` costs 100 — so roughly a hundred search calls consume the entire
 * day and the only symptom is a 403 on the next upload, at 3am, with no obvious
 * cause. Nothing in the repo counted units before this.
 *
 * Two jobs:
 *   1. Account for every unit, against the correct (Pacific) day boundary.
 *   2. Let the publish lane RESERVE its 1,600 units so discretionary reads
 *      cannot starve it.
 *
 * `search.list` is deny-by-default (see SEARCH_METHODS). It is the single
 * cheapest way to destroy a day's quota and there is almost always a zero- or
 * one-unit alternative: the channel RSS feed, or `playlistItems.list` against
 * the uploads playlist. Override with `allowSearch: true` only deliberately.
 *
 * Storage is SQLite, matching the sibling modules in this directory. Pass
 * ':memory:' for tests.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('youtube:quota');

/**
 * Unit costs for the Data API v3 methods this repo calls.
 * Source: developers.google.com/youtube/v3/determine_quota_cost
 */
export const QUOTA_COSTS = {
  'videos.list': 1,
  'videos.insert': 1600,
  'videos.update': 50,
  'channels.list': 1,
  'playlistItems.list': 1,
  'commentThreads.list': 1,
  'comments.insert': 50,
  'thumbnails.set': 50,
  'search.list': 100,
} as const;

export type QuotaMethod = keyof typeof QUOTA_COSTS;

/** Methods refused unless explicitly allowed — see the file header. */
export const SEARCH_METHODS: readonly QuotaMethod[] = ['search.list'];

/** Google's documented default project allowance. */
export const DEFAULT_DAILY_UNITS = 10_000;

export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly method: QuotaMethod,
    readonly remaining: number,
  ) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export class SearchDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchDeniedError';
  }
}

export interface QuotaLedgerOptions {
  dbPath: string;
  /** Total units available per day. Default 10,000 (Google's default project allowance). */
  dailyLimit?: number;
  /** Units held back for the publish lane so reads cannot starve it. Default 1,600 (one upload). */
  publishReserve?: number;
  /** Injectable clock — tests drive day rollover with it. */
  now?: () => Date;
}

export interface QuotaStatus {
  /** Pacific calendar day this status describes, YYYY-MM-DD. */
  day: string;
  limit: number;
  spent: number;
  /** Units left after the publish reserve is set aside. What reads may use. */
  available: number;
  /** Units left in absolute terms, including the reserve. */
  remaining: number;
  publishReserve: number;
}

/**
 * The Pacific calendar day for an instant, as YYYY-MM-DD.
 *
 * Uses the IANA zone rather than a fixed UTC offset so the boundary stays
 * correct across PST/PDT transitions — a fixed -8 would mis-bucket eight months
 * of the year by an hour.
 */
export function pacificDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  // en-CA already yields YYYY-MM-DD.
  return parts;
}

export class QuotaLedger {
  private readonly db: Database.Database;
  private readonly dailyLimit: number;
  private readonly publishReserve: number;
  private readonly now: () => Date;

  constructor(opts: QuotaLedgerOptions) {
    this.dailyLimit = opts.dailyLimit ?? DEFAULT_DAILY_UNITS;
    this.publishReserve = opts.publishReserve ?? QUOTA_COSTS['videos.insert'];
    this.now = opts.now ?? (() => new Date());

    if (opts.dbPath !== ':memory:') {
      const dir = dirname(opts.dbPath);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS youtube_quota (
        day    TEXT NOT NULL,
        method TEXT NOT NULL,
        units  INTEGER NOT NULL,
        calls  INTEGER NOT NULL,
        PRIMARY KEY (day, method)
      );
    `);
  }

  /** Current Pacific day, as used for bucketing. */
  today(): string {
    return pacificDay(this.now());
  }

  /** Units already consumed today. */
  spent(): number {
    const row = this.db
      .prepare<[string], { total: number | null }>(
        `SELECT SUM(units) AS total FROM youtube_quota WHERE day = ?`,
      )
      .get(this.today());
    return row?.total ?? 0;
  }

  status(): QuotaStatus {
    const spent = this.spent();
    const remaining = Math.max(0, this.dailyLimit - spent);
    return {
      day: this.today(),
      limit: this.dailyLimit,
      spent,
      available: Math.max(0, remaining - this.publishReserve),
      remaining,
      publishReserve: this.publishReserve,
    };
  }

  /**
   * Can this call proceed?
   *
   * `videos.insert` may draw on the publish reserve; everything else must fit in
   * what is left after the reserve is set aside. That asymmetry is the whole
   * point — it is what stops a chatty analytics job from making the day's upload
   * impossible.
   */
  canAfford(method: QuotaMethod, count = 1): boolean {
    const cost = QUOTA_COSTS[method] * count;
    const s = this.status();
    const budget = method === 'videos.insert' ? s.remaining : s.available;
    return cost <= budget;
  }

  /** Record units actually consumed. Call after the request, not before. */
  record(method: QuotaMethod, count = 1): void {
    const units = QUOTA_COSTS[method] * count;
    this.db
      .prepare<[string, string, number, number]>(
        `INSERT INTO youtube_quota (day, method, units, calls) VALUES (?, ?, ?, ?)
         ON CONFLICT(day, method) DO UPDATE SET units = units + excluded.units,
                                                calls = calls + excluded.calls`,
      )
      .run(this.today(), method, units, count);

    const s = this.status();
    if (s.remaining < this.publishReserve) {
      log.warn(
        { spent: s.spent, remaining: s.remaining, method },
        'YouTube quota below the publish reserve — today\'s upload may be impossible',
      );
    }
  }

  /**
   * Assert a call may proceed, then record it.
   *
   * @throws {SearchDeniedError} for `search.list` without an explicit override.
   * @throws {QuotaExceededError} when the budget cannot cover the call.
   */
  spend(method: QuotaMethod, count = 1, opts: { allowSearch?: boolean } = {}): void {
    if (SEARCH_METHODS.includes(method) && !opts.allowSearch) {
      throw new SearchDeniedError(
        `${method} is denied by default: it costs ${QUOTA_COSTS[method]} units and can consume ` +
          'the entire daily quota in ~100 calls. Use the channel RSS feed (0 units) or ' +
          'playlistItems.list on the uploads playlist (1 unit). Pass allowSearch to override.',
      );
    }
    if (!this.canAfford(method, count)) {
      const s = this.status();
      throw new QuotaExceededError(
        `YouTube quota exhausted: ${method}×${count} needs ${QUOTA_COSTS[method] * count} units, ` +
          `${method === 'videos.insert' ? s.remaining : s.available} available ` +
          `(spent ${s.spent}/${s.limit} on ${s.day} Pacific).`,
        method,
        s.remaining,
      );
    }
    this.record(method, count);
  }

  /** Per-method breakdown for today — the input to a quota dashboard. */
  breakdown(): Array<{ method: string; units: number; calls: number }> {
    return this.db
      .prepare<[string], { method: string; units: number; calls: number }>(
        `SELECT method, units, calls FROM youtube_quota WHERE day = ? ORDER BY units DESC`,
      )
      .all(this.today());
  }

  close(): void {
    this.db.close();
  }
}
