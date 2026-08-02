/**
 * @file thumbnails.ts
 * @description Thumbnail deployment + real CTR measurement (GAP-04b).
 *
 * The audit found `thumbnail-ab.ts` doing two impossible things: it "tested"
 * variants it could not deploy (**no `thumbnails.set` call existed anywhere in
 * the repo**) and "measured" a CTR it could not read (it wrote a hardcoded 0.04).
 * GAP-04a stopped the fabrication. This adds the two real capabilities.
 *
 * ## The honesty problem, stated plainly
 *
 * **This cannot do what YouTube Studio's "Test & Compare" does.** Studio runs a
 * *concurrent* split test — the same video, same hour, impressions randomly
 * divided between thumbnails. There is no API for that (audit Gate 2).
 *
 * What the API permits is a **sequential** test: deploy A, wait, measure; deploy
 * B, wait, measure. That is confounded by everything that changes with time —
 * day of week, video age decay, whether the algorithm happened to surface the
 * video that week. A 15% CTR difference between two *sequential* windows is not
 * evidence that one thumbnail is 15% better.
 *
 * So the measurement here is real, and the *inference* is deliberately
 * conservative: a winner is declared only when a two-proportion z-test clears
 * p < 0.05 **and** both variants have enough impressions to make that meaningful.
 * Otherwise the verdict is `inconclusive`, and the time-confound is recorded on
 * the result so nobody downstream mistakes it for a controlled experiment.
 *
 * Replacing fabricated numbers with real-but-misinterpreted numbers would have
 * been a lateral move.
 */

import { readFileSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';
import { getYouTubeAccessToken, hasYouTubeCredential } from './auth.js';
import { QuotaLedger, QuotaExceededError } from './quota-ledger.js';

const log = createLogger('youtube:thumbnails');

const THUMBNAIL_SET_URL = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';
const ANALYTICS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';

/** Below this, a CTR difference is noise; the z-test would not clear anyway. */
export const MIN_IMPRESSIONS_FOR_VERDICT = 1_000;

/** Two-sided p threshold for declaring a winner. */
export const SIGNIFICANCE_P = 0.05;

export interface ThumbnailDeps {
  fetch: typeof globalThis.fetch;
  token: () => Promise<string>;
  ledger?: { spend(method: 'thumbnails.set', count?: number): void };
}

function defaultDeps(): ThumbnailDeps {
  return {
    fetch: (...a) => globalThis.fetch(...a),
    token: async () => (await getYouTubeAccessToken()).accessToken,
    ledger: new QuotaLedger({ dbPath: process.env['SUDO_YT_QUOTA_DB'] ?? 'data/youtube-quota.db' }),
  };
}

// ---------------------------------------------------------------------------
// Deploy — thumbnails.set (50 quota units)
// ---------------------------------------------------------------------------

export type DeployOutcome =
  | { status: 'deployed'; videoId: string; bytes: number; quotaUnits: number }
  | { status: 'refused'; reason: string; blockedBy: 'flag' | 'auth' | 'quota' | 'file' | 'api' };

/** YouTube rejects thumbnails over 2 MB. Fail before the upload, not after. */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/**
 * Set a video's thumbnail. **50 quota units.**
 *
 * Gated by `SUDO_YT_PUBLISH_ENABLED` — this mutates a live channel, and swapping
 * the thumbnail on a performing video is a visible, viewer-facing change.
 */
export async function setThumbnail(
  videoId: string,
  imagePath: string,
  deps: ThumbnailDeps = defaultDeps(),
): Promise<DeployOutcome> {
  if (!videoId?.trim()) return { status: 'refused', reason: 'videoId is required', blockedBy: 'file' };
  if (process.env['SUDO_YT_PUBLISH_ENABLED'] !== '1') {
    return {
      status: 'refused',
      blockedBy: 'flag',
      reason: 'Thumbnail deployment is disabled — it changes a live channel. Set SUDO_YT_PUBLISH_ENABLED=1.',
    };
  }
  if (!hasYouTubeCredential()) {
    return { status: 'refused', reason: 'No YouTube credential configured', blockedBy: 'auth' };
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(imagePath);
  } catch (err) {
    return { status: 'refused', reason: `Cannot read ${imagePath}: ${(err as Error).message}`, blockedBy: 'file' };
  }
  if (bytes.length > MAX_THUMBNAIL_BYTES) {
    return {
      status: 'refused',
      blockedBy: 'file',
      reason: `Thumbnail is ${(bytes.length / 1048576).toFixed(2)} MB; YouTube's limit is 2 MB. ` +
        'Compress it — the upload would be rejected after spending 50 quota units.',
    };
  }

  let token: string;
  try {
    token = await deps.token();
  } catch (err) {
    return { status: 'refused', reason: `YouTube auth failed: ${(err as Error).message}`, blockedBy: 'auth' };
  }

  try {
    deps.ledger?.spend('thumbnails.set');
  } catch (err) {
    if (err instanceof QuotaExceededError) return { status: 'refused', reason: err.message, blockedBy: 'quota' };
    throw err;
  }

  const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  try {
    const res = await deps.fetch(`${THUMBNAIL_SET_URL}?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: 'refused', reason: `thumbnails.set failed: HTTP ${res.status}: ${text.slice(0, 200)}`, blockedBy: 'api' };
    }
  } catch (err) {
    return { status: 'refused', reason: `thumbnails.set error: ${(err as Error).message}`, blockedBy: 'api' };
  }

  log.info({ videoId, bytes: bytes.length }, 'Thumbnail deployed');
  return { status: 'deployed', videoId, bytes: bytes.length, quotaUnits: 50 };
}

// ---------------------------------------------------------------------------
// Measure — Analytics impressions + CTR (not charged against the Data API quota)
// ---------------------------------------------------------------------------

export interface CtrSample {
  impressions: number;
  /** Clicks derived from impressions x CTR; YouTube reports the rate, not the count. */
  clicks: number;
  /** 0..1 */
  ctr: number;
}

/**
 * Read real impressions and CTR for a video over a window.
 *
 * Uses the Analytics metrics `impressions` and `impressionClickThroughRate`.
 * Returns null when unavailable — an unmeasured window must never read as zero,
 * which is the mistake GAP-04a existed to correct.
 */
export async function fetchThumbnailCtr(
  videoId: string,
  startDate: string,
  endDate: string,
  deps: ThumbnailDeps = defaultDeps(),
): Promise<CtrSample | null> {
  let token: string;
  try {
    token = await deps.token();
  } catch {
    return null;
  }

  const qs = new URLSearchParams({
    ids: 'channel==MINE',
    startDate,
    endDate,
    metrics: 'impressions,impressionClickThroughRate',
    filters: `video==${videoId}`,
  });

  try {
    const res = await deps.fetch(`${ANALYTICS_URL}?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      log.warn({ videoId, status: res.status }, 'Analytics CTR fetch returned non-OK');
      return null;
    }
    const data = (await res.json()) as { rows?: Array<Array<number | string>> };
    const row = data.rows?.[0];
    if (!row || typeof row[0] !== 'number' || typeof row[1] !== 'number') return null;

    const impressions = row[0];
    // YouTube reports impressionClickThroughRate as a PERCENTAGE (e.g. 4.7),
    // not a fraction. Storing 4.7 as a rate would overstate CTR 100x.
    const ctr = row[1] / 100;
    return { impressions, ctr, clicks: Math.round(impressions * ctr) };
  } catch (err) {
    log.warn({ videoId, err: String(err) }, 'Analytics CTR fetch failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inference — refuse to call a winner the data does not support
// ---------------------------------------------------------------------------

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

export interface ZTestResult {
  z: number;
  /** Two-sided. */
  pValue: number;
  significant: boolean;
}

/** Two-proportion z-test on clicks/impressions. */
export function twoProportionZTest(a: CtrSample, b: CtrSample): ZTestResult {
  if (a.impressions === 0 || b.impressions === 0) return { z: 0, pValue: 1, significant: false };
  const pPool = (a.clicks + b.clicks) / (a.impressions + b.impressions);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.impressions + 1 / b.impressions));
  if (se === 0) return { z: 0, pValue: 1, significant: false };
  const z = (a.clicks / a.impressions - b.clicks / b.impressions) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pValue, significant: pValue < SIGNIFICANCE_P };
}

export interface VariantSample extends CtrSample {
  variant: string;
}

export type ComparisonVerdict =
  | { verdict: 'winner'; variant: string; pValue: number; lift: number; caveat: string }
  | { verdict: 'inconclusive'; reason: string; pValue: number | null };

/**
 * Compare measured variants.
 *
 * Declares a winner only when the top two differ significantly **and** both have
 * at least {@link MIN_IMPRESSIONS_FOR_VERDICT} impressions. Every winner carries
 * the sequential-test caveat, because these samples were not gathered
 * concurrently and the difference may be time, not thumbnail.
 */
export function compareVariants(samples: VariantSample[]): ComparisonVerdict {
  const measured = samples.filter((s) => s.impressions > 0);
  if (measured.length < 2) {
    return { verdict: 'inconclusive', reason: 'Fewer than two variants have measured impressions.', pValue: null };
  }

  const sorted = [...measured].sort((x, y) => y.ctr - x.ctr);
  const [top, runnerUp] = sorted as [VariantSample, VariantSample];

  const underpowered = measured.filter((s) => s.impressions < MIN_IMPRESSIONS_FOR_VERDICT);
  if (underpowered.length > 0) {
    return {
      verdict: 'inconclusive',
      pValue: null,
      reason: `${underpowered.map((s) => s.variant).join(', ')} below ${MIN_IMPRESSIONS_FOR_VERDICT.toLocaleString()} ` +
        'impressions — too few for a CTR difference to mean anything. Keep running.',
    };
  }

  const t = twoProportionZTest(top, runnerUp);
  if (!t.significant) {
    return {
      verdict: 'inconclusive',
      pValue: t.pValue,
      reason: `Top two differ by ${((top.ctr - runnerUp.ctr) * 100).toFixed(2)}pp but p=${t.pValue.toFixed(3)} ` +
        `(need < ${SIGNIFICANCE_P}). Not distinguishable from noise.`,
    };
  }

  return {
    verdict: 'winner',
    variant: top.variant,
    pValue: t.pValue,
    lift: runnerUp.ctr === 0 ? 0 : (top.ctr - runnerUp.ctr) / runnerUp.ctr,
    caveat:
      'SEQUENTIAL test — variants ran in different time windows, so this difference is confounded ' +
      'with day-of-week, video age and algorithmic surfacing. It is NOT a concurrent split test; ' +
      'only Studio Test & Compare provides that.',
  };
}
