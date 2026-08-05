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
import { setThumbnail, fetchThumbnailCtr, compareVariants } from './thumbnails.js';
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

    // GAP-04b: decide with a two-proportion z-test over real impressions rather
    // than by comparing CTR numbers directly. Highest-CTR-wins would crown a
    // variant on 100 impressions over one on 50,000, and a sequential test is
    // already confounded enough without adding small-sample noise on top.
    const comparison = compareVariants(
      withCtr.map(v => ({
        variant: v.variant,
        impressions: v.impressions ?? 0,
        clicks: v.clicks ?? 0,
        ctr: v.measuredCtr ?? 0,
      })),
    );

    if (comparison.verdict === 'inconclusive') {
      log.warn({ testId, reason: comparison.reason, pValue: comparison.pValue },
        'Thumbnail A/B inconclusive — no winner selected');
      return null;
    }

    const winner = withCtr.find(v => v.variant === comparison.variant);
    if (!winner) return null;
    log.info({ testId, variant: winner.variant, pValue: comparison.pValue, caveat: comparison.caveat },
      'Thumbnail A/B winner selected');

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
   * Record real per-variant CTR from the Analytics API (GAP-04b).
   *
   * History worth keeping: this once wrote a hardcoded `measured_ctr = 0.04` and
   * `impressions = viewCount` for every variant. Both were inventions — the
   * public statistics endpoint exposes neither impressions nor CTR, and views
   * are not impressions — and they landed in the columns real measurements
   * occupy, so nothing downstream could tell them apart. GAP-04a replaced that
   * with nothing; this replaces the nothing with real data.
   *
   * Each variant is measured over **its own deployment window**: from when it
   * was deployed until the next variant took over (or now, for the live one).
   * That is what makes this a sequential test, with all the time-confounding
   * that implies — recorded on the verdict by `compareVariants`, never hidden.
   *
   * A variant that was never deployed has no window and is skipped. A window
   * with no Analytics data records **nothing**, not zero.
   */
  private async _fetchAndStoreCtr(test: ABTest): Promise<void> {
    const deployed = test.variants
      .filter(v => v.deployedAt)
      .sort((a, b) => (a.deployedAt! < b.deployedAt! ? -1 : 1));

    if (deployed.length === 0) {
      log.warn({ testId: test.id }, 'No variant has been deployed — nothing to measure');
      return;
    }

    const day = (iso: string): string => iso.slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    const stmt = this.db.prepare<[number, number, number, string]>(
      `UPDATE ab_variants SET impressions = ?, clicks = ?, measured_ctr = ? WHERE id = ?`,
    );

    for (let i = 0; i < deployed.length; i++) {
      const v = deployed[i]!;
      const start = day(v.deployedAt!);
      // The window closes when the NEXT variant was deployed; the last one runs to today.
      const next = deployed[i + 1];
      const end = next ? day(next.deployedAt!) : today;

      const sample = await fetchThumbnailCtr(test.videoId, start, end);
      if (!sample) {
        log.warn({ testId: test.id, variant: v.variant, start, end },
          'No Analytics data for this variant window — recording nothing, not zero');
        continue;
      }
      stmt.run(sample.impressions, sample.clicks, sample.ctr, v.id);
      log.info({ variant: v.variant, impressions: sample.impressions, ctr: sample.ctr },
        'Real CTR recorded for variant window');
    }
  }

  /**
   * Deploy a variant's thumbnail to the live video and stamp its window open.
   *
   * 50 quota units, and gated by `SUDO_YT_PUBLISH_ENABLED` inside
   * {@link setThumbnail} — this is a viewer-visible change to a live channel.
   * `deployedAt` is only written on a confirmed deploy, so a failed upload
   * cannot open a measurement window that never actually ran.
   */
  async deployVariant(testId: string, variant: string): Promise<{ ok: boolean; message: string }> {
    const test = this.getTestResults(testId);
    if (!test) return { ok: false, message: `Test not found: ${testId}` };
    const v = test.variants.find(x => x.variant === variant);
    if (!v) return { ok: false, message: `Variant not found: ${variant}` };

    const out = await setThumbnail(test.videoId, v.imagePath);
    if (out.status !== 'deployed') return { ok: false, message: out.reason };

    this.db
      .prepare<[string, string]>(`UPDATE ab_variants SET deployed_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), v.id);
    log.info({ testId, variant, videoId: test.videoId }, 'Variant deployed and window opened');
    return { ok: true, message: `Variant ${variant} deployed to ${test.videoId} (50 quota units)` };
  }
}
