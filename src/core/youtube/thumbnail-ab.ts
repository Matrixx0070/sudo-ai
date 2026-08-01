/**
 * @file thumbnail-ab.ts
 * @description Thumbnail A/B Testing — deploy variant thumbnails, measure CTR,
 * auto-select winner.
 *
 * Uses better-sqlite3 for persistence. Each test tracks multiple thumbnail
 * variants. After the measurement window expires, evaluateTest() compares
 * CTR across variants and marks the winner.
 *
 * Environment:
 *   YOUTUBE_API_KEY      — YouTube Data API v3 key (used for CTR polling)
 *   YOUTUBE_CHANNEL_ID   — Channel ID for the channel being tested
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  initABSchema,
  rowToTest,
  rowToVariant,
  type ABTest,
  type ThumbnailVariant,
  type ABTestRow,
  type ABVariantRow,
} from './thumbnail-ab-schema.js';

export type { ABTest, ThumbnailVariant } from './thumbnail-ab-schema.js';

const log = createLogger('youtube:thumbnail-ab');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// ThumbnailABTester
// ---------------------------------------------------------------------------

export class ThumbnailABTester {
  private readonly db: Database.Database;

  constructor(private readonly dbPath: string) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('ThumbnailABTester: dbPath must be a non-empty string');
    }
    ensureDir(dbPath);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    initABSchema(this.db);
    log.info({ dbPath }, 'ThumbnailABTester initialised');
  }

  // -------------------------------------------------------------------------
  // createTest
  // -------------------------------------------------------------------------

  createTest(
    videoId: string,
    variants: Omit<ThumbnailVariant, 'id' | 'isWinner'>[],
    measureAfterHours = 48,
  ): ABTest {
    if (!videoId?.trim()) throw new Error('videoId is required');
    if (!Array.isArray(variants) || variants.length < 2) {
      throw new Error('At least 2 variants are required for an A/B test');
    }
    if (variants.length > 6) throw new Error('Maximum 6 variants per test');
    for (const v of variants) {
      if (!v.variant?.trim()) throw new Error('Each variant must have a variant label (A, B, C…)');
      if (!v.imagePath?.trim()) throw new Error('Each variant must have an imagePath');
    }
    if (measureAfterHours < 1 || measureAfterHours > 720) {
      throw new Error('measureAfterHours must be between 1 and 720');
    }

    const testId = randomUUID();

    const insertTest = this.db.prepare<[string, string, number]>(
      `INSERT INTO ab_tests (id, video_id, measure_after_hours) VALUES (?, ?, ?)`,
    );
    const insertVariant = this.db.prepare<[string, string, string, string, string, string]>(
      `INSERT INTO ab_variants (id, test_id, video_id, variant, image_path, description) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const run = this.db.transaction(() => {
      insertTest.run(testId, videoId.trim(), measureAfterHours);
      for (const v of variants) {
        insertVariant.run(
          randomUUID(),
          testId,
          videoId.trim(),
          v.variant.trim(),
          v.imagePath.trim(),
          (v.description ?? '').trim(),
        );
      }
    });

    run();
    log.info({ testId, videoId, variants: variants.length }, 'A/B test created');
    return this.getTestResults(testId)!;
  }

  // -------------------------------------------------------------------------
  // startTest
  // -------------------------------------------------------------------------

  startTest(testId: string): void {
    if (!testId?.trim()) throw new Error('testId is required');

    const test = this.getTestResults(testId);
    if (!test) throw new Error(`Test not found: ${testId}`);
    if (test.status !== 'setup') {
      throw new Error(`Test ${testId} is already in status "${test.status}" — can only start from "setup"`);
    }

    const stmt = this.db.prepare<[string, string]>(
      `UPDATE ab_tests SET status = 'running', started_at = ? WHERE id = ?`,
    );
    stmt.run(new Date().toISOString(), testId.trim());
    log.info({ testId }, 'A/B test started');
  }

  // -------------------------------------------------------------------------
  // evaluateTest — check if measurement window has elapsed, fetch CTR, pick winner
  // -------------------------------------------------------------------------

  async evaluateTest(testId: string): Promise<ABTest> {
    if (!testId?.trim()) throw new Error('testId is required');

    const test = this.getTestResults(testId);
    if (!test) throw new Error(`Test not found: ${testId}`);
    if (test.status === 'completed') {
      log.info({ testId }, 'Test already completed');
      return test;
    }
    if (test.status !== 'running') {
      throw new Error(`Test ${testId} is not running (status: ${test.status})`);
    }

    const elapsedHours = test.startedAt
      ? (Date.now() - new Date(test.startedAt).getTime()) / 3_600_000
      : 0;

    if (elapsedHours < test.measureAfterHours) {
      const remaining = (test.measureAfterHours - elapsedHours).toFixed(1);
      log.info({ testId, remaining }, 'Measurement window not yet elapsed');
      return test;
    }

    // Attempt to fetch live CTR data from YouTube API
    await this._fetchAndStoreCtr(test);

    // Select winner
    this.selectWinner(testId);
    return this.getTestResults(testId)!;
  }

  // -------------------------------------------------------------------------
  // selectWinner — pick variant with highest measuredCtr; mark completed
  // -------------------------------------------------------------------------

  selectWinner(testId: string): ThumbnailVariant | null {
    if (!testId?.trim()) throw new Error('testId is required');

    const test = this.getTestResults(testId);
    if (!test) throw new Error(`Test not found: ${testId}`);

    const withCtr = test.variants.filter(v => v.measuredCtr !== undefined);
    if (withCtr.length === 0) {
      log.warn({ testId }, 'No CTR data available — cannot select winner');
      return null;
    }

    const winner = withCtr.reduce((best, v) =>
      (v.measuredCtr ?? 0) > (best.measuredCtr ?? 0) ? v : best,
    );

    // If multiple variants share the top CTR, the result is a tie and picking
    // one arbitrarily (the reduce seed / first variant) would be misleading.
    // Decline to declare a winner rather than crowning variant 'A' by default.
    const bestCtr = winner.measuredCtr ?? 0;
    const tiedForLead = withCtr.filter(v => (v.measuredCtr ?? 0) === bestCtr);
    if (tiedForLead.length > 1) {
      log.warn(
        { testId, ctr: bestCtr, tied: tiedForLead.map(v => v.variant) },
        'CTR is tied across variants — inconclusive, no winner selected',
      );
      return null;
    }

    const markWinner = this.db.prepare<[string]>(`UPDATE ab_variants SET is_winner = 1 WHERE id = ?`);
    const completeTest = this.db.prepare<[string, string, string]>(
      `UPDATE ab_tests SET status = 'completed', winner_variant = ?, completed_at = ? WHERE id = ?`,
    );

    const run = this.db.transaction(() => {
      markWinner.run(winner.id);
      completeTest.run(winner.variant, new Date().toISOString(), testId);
    });
    run();

    log.info({ testId, winner: winner.variant, ctr: winner.measuredCtr }, 'Winner selected');
    return { ...winner, isWinner: true };
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getActiveTests(): ABTest[] {
    const rows = this.db
      .prepare<[], ABTestRow>(`SELECT * FROM ab_tests WHERE status IN ('setup','running') ORDER BY created_at DESC`)
      .all();
    return rows.map(r => this._hydrateTest(r));
  }

  getTestHistory(limit = 20): ABTest[] {
    const n = Math.min(Math.max(1, limit), 200);
    const rows = this.db
      .prepare<[number], ABTestRow>(`SELECT * FROM ab_tests ORDER BY created_at DESC LIMIT ?`)
      .all(n);
    return rows.map(r => this._hydrateTest(r));
  }

  getTestResults(testId: string): ABTest | null {
    if (!testId?.trim()) return null;
    const row = this.db
      .prepare<[string], ABTestRow>(`SELECT * FROM ab_tests WHERE id = ?`)
      .get(testId.trim());
    if (!row) return null;
    return this._hydrateTest(row);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _hydrateTest(row: ABTestRow): ABTest {
    const variantRows = this.db
      .prepare<[string], ABVariantRow>(`SELECT * FROM ab_variants WHERE test_id = ? ORDER BY variant ASC`)
      .all(row.id);
    return rowToTest(row, variantRows.map(rowToVariant));
  }

  /**
   * Attempt to record real per-variant CTR.
   *
   * GAP-04a. This used to write a hardcoded `measured_ctr = 0.04` for every
   * variant and `impressions = viewCount`, then log "CTR stub stored". Both
   * numbers were inventions: the public `videos?part=statistics` endpoint
   * exposes neither impressions nor CTR, and views are not impressions. The
   * values landed in the same columns real measurements would occupy, so
   * nothing downstream could tell them apart — a system that reports fabricated
   * experiment results is worse than one with no experiments, because the
   * fabrications get believed.
   *
   * It now records nothing it cannot measure. `measured_ctr` stays NULL, and
   * selectWinner() correctly declines to pick a winner from no data.
   *
   * Real per-variant CTR needs the Analytics API (`impressions`,
   * `impressionClickThroughRate`) plus a thumbnail deploy via `thumbnails.set`
   * — neither exists yet. That is GAP-04b; see audit/03-GAPS.md.
   */
  private async _fetchAndStoreCtr(test: ABTest): Promise<void> {
    log.warn(
      { testId: test.id, videoId: test.videoId, variants: test.variants.length },
      'Per-variant CTR is not measurable yet (needs Analytics API impressions + thumbnails.set — ' +
        'GAP-04b). Recording no measurement rather than a fabricated one.',
    );
  }
}
