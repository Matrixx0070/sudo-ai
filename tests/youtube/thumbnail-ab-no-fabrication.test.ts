/**
 * Regression test for GAP-04a.
 *
 * `_fetchAndStoreCtr` used to write a hardcoded `measured_ctr = 0.04` and
 * `impressions = viewCount` for every variant, into the same columns a real
 * measurement would occupy. Nothing downstream could tell the invention from
 * data. This test asserts the ledger stays empty when nothing is measurable.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThumbnailABTester } from '../../src/core/youtube/thumbnail-ab.js';

const dirs: string[] = [];

function tester() {
  const dir = mkdtempSync(join(tmpdir(), 'yt-ab-'));
  dirs.push(dir);
  return new ThumbnailABTester(join(dir, 'ab.db'));
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const VARIANTS = [
  { videoId: 'vid123', variant: 'A', imagePath: '/tmp/a.jpg', description: 'bold text' },
  { videoId: 'vid123', variant: 'B', imagePath: '/tmp/b.jpg', description: 'face closeup' },
];

describe('thumbnail A/B does not fabricate measurements', () => {
  it('leaves measuredCtr unset after evaluation instead of stamping 0.04', async () => {
    const ab = tester();
    const test = ab.createTest('vid123', VARIANTS, 1);
    ab.startTest(test.id);

    // Force the measurement window open by backdating the start.
    (ab as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare(`UPDATE ab_tests SET started_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 10 * 3_600_000).toISOString(), test.id);

    const evaluated = await ab.evaluateTest(test.id);

    for (const v of evaluated.variants) {
      expect(v.measuredCtr, `variant ${v.variant} must have no fabricated CTR`).toBeUndefined();
    }
    // Specifically: the old hardcoded industry-average constant must not appear.
    expect(evaluated.variants.map(v => v.measuredCtr)).not.toContain(0.04);
  });

  it('declines to crown a winner when there is no data', async () => {
    const ab = tester();
    const test = ab.createTest('vid123', VARIANTS, 1);
    ab.startTest(test.id);
    expect(ab.selectWinner(test.id)).toBeNull();

    const after = ab.getTestResults(test.id);
    expect(after?.status).not.toBe('completed');
    expect(after?.variants.some(v => v.isWinner)).toBe(false);
  });

  it('makes no network call during evaluation', async () => {
    const ab = tester();
    const test = ab.createTest('vid123', VARIANTS, 1);
    ab.startTest(test.id);

    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error('no network expected');
    }) as typeof globalThis.fetch;
    try {
      (ab as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
        .prepare(`UPDATE ab_tests SET started_at = ? WHERE id = ?`)
        .run(new Date(Date.now() - 10 * 3_600_000).toISOString(), test.id);
      await ab.evaluateTest(test.id);
    } finally {
      globalThis.fetch = original;
    }
    expect(called).toBe(false);
  });
});
