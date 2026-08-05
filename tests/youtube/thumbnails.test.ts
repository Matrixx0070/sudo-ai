/**
 * Tests for thumbnail deploy + real CTR measurement (GAP-04b).
 *
 * GAP-04a removed a fabricated CTR. The risk in replacing it is subtler: real
 * numbers, misinterpreted. A sequential deploy-measure-swap-measure cycle is not
 * a controlled experiment, so the tests below care most about the module
 * REFUSING to call a winner the data cannot support.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setThumbnail,
  fetchThumbnailCtr,
  twoProportionZTest,
  compareVariants,
  normalCdf,
  MIN_IMPRESSIONS_FOR_VERDICT,
  MAX_THUMBNAIL_BYTES,
  type ThumbnailDeps,
  type VariantSample,
} from '../../src/core/youtube/thumbnails.js';

let dir: string;
let imgPath: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['SUDO_YT_PUBLISH_ENABLED', 'YOUTUBE_OAUTH_TOKEN'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thumb-'));
  imgPath = join(dir, 'a.jpg');
  writeFileSync(imgPath, Buffer.alloc(1024));
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
});

function deps(over: { status?: number; body?: unknown } = {}): ThumbnailDeps & { fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async () => ({
    ok: (over.status ?? 200) < 300,
    status: over.status ?? 200,
    json: async () => over.body ?? {},
    text: async () => 'err',
  }) as unknown as Response);
  return { fetch, token: async () => 'tok' } as ThumbnailDeps & { fetch: ReturnType<typeof vi.fn> };
}

const enable = () => {
  process.env['SUDO_YT_PUBLISH_ENABLED'] = '1';
  process.env['YOUTUBE_OAUTH_TOKEN'] = 'legacy';
};

describe('setThumbnail — deploy (50 quota units)', () => {
  it('is refused by default — it changes a live channel', async () => {
    const d = deps();
    const out = await setThumbnail('vid1', imgPath, d);
    expect(out.status).toBe('refused');
    if (out.status === 'refused') expect(out.blockedBy).toBe('flag');
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('uploads to thumbnails/set with the right content type when enabled', async () => {
    enable();
    const d = deps();
    const out = await setThumbnail('vid1', imgPath, d);
    expect(out.status).toBe('deployed');
    const [url, init] = d.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/upload/youtube/v3/thumbnails/set');
    expect(url).toContain('videoId=vid1');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg');
  });

  it('detects PNG by extension', async () => {
    enable();
    const png = join(dir, 'b.png');
    writeFileSync(png, Buffer.alloc(64));
    const d = deps();
    await setThumbnail('vid1', png, d);
    const [, init] = d.fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
  });

  it('rejects an oversize thumbnail BEFORE spending 50 quota units', async () => {
    enable();
    const big = join(dir, 'big.jpg');
    writeFileSync(big, Buffer.alloc(MAX_THUMBNAIL_BYTES + 1));
    const spend = vi.fn();
    const d = { ...deps(), ledger: { spend } };
    const out = await setThumbnail('vid1', big, d);
    expect(out.status).toBe('refused');
    if (out.status === 'refused') expect(out.blockedBy).toBe('file');
    expect(spend, 'quota must not be spent on an upload YouTube would reject').not.toHaveBeenCalled();
  });

  it('charges thumbnails.set once on a real deploy', async () => {
    enable();
    const spend = vi.fn();
    const out = await setThumbnail('vid1', imgPath, { ...deps(), ledger: { spend } });
    expect(spend).toHaveBeenCalledWith('thumbnails.set');
    if (out.status === 'deployed') expect(out.quotaUnits).toBe(50);
  });

  it('surfaces an API failure rather than reporting success', async () => {
    enable();
    const out = await setThumbnail('vid1', imgPath, deps({ status: 403 }));
    expect(out.status).toBe('refused');
    if (out.status === 'refused') expect(out.blockedBy).toBe('api');
  });

  it('refuses a missing file without spending quota', async () => {
    enable();
    const spend = vi.fn();
    const out = await setThumbnail('vid1', join(dir, 'nope.jpg'), { ...deps(), ledger: { spend } });
    expect(out.status).toBe('refused');
    expect(spend).not.toHaveBeenCalled();
  });
});

describe('fetchThumbnailCtr — real measurement', () => {
  it('converts YouTube percentage CTR to a fraction', async () => {
    // 50,000 impressions at 4.7% -> ctr 0.047, clicks 2350.
    const d = deps({ body: { rows: [[50_000, 4.7]] } });
    const s = await fetchThumbnailCtr('vid1', '2026-07-01', '2026-07-31', d);
    expect(s).not.toBeNull();
    expect(s!.impressions).toBe(50_000);
    expect(s!.ctr).toBeCloseTo(0.047, 6);
    expect(s!.clicks).toBe(2_350);
  });

  it('filters to the single video and asks for the right metrics', async () => {
    const d = deps({ body: { rows: [[10, 5]] } });
    await fetchThumbnailCtr('vid1', '2026-07-01', '2026-07-31', d);
    const url = String(d.fetch.mock.calls[0]![0]);
    expect(url).toContain('metrics=impressions%2CimpressionClickThroughRate');
    expect(url).toContain('video%3D%3Dvid1');
  });

  it('returns null — never zero — when the window has no data', async () => {
    expect(await fetchThumbnailCtr('v', '2026-07-01', '2026-07-31', deps({ body: {} }))).toBeNull();
    expect(await fetchThumbnailCtr('v', '2026-07-01', '2026-07-31', deps({ status: 403 }))).toBeNull();
  });
});

describe('statistics', () => {
  it('normalCdf matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('finds a large, well-sampled difference significant', () => {
    const a = { impressions: 50_000, clicks: 3_000, ctr: 0.06 };
    const b = { impressions: 50_000, clicks: 2_000, ctr: 0.04 };
    const t = twoProportionZTest(a, b);
    expect(t.significant).toBe(true);
    expect(t.pValue).toBeLessThan(0.001);
  });

  it('does NOT find a tiny difference significant', () => {
    const a = { impressions: 50_000, clicks: 2_010, ctr: 0.0402 };
    const b = { impressions: 50_000, clicks: 2_000, ctr: 0.04 };
    expect(twoProportionZTest(a, b).significant).toBe(false);
  });

  it('handles empty samples without dividing by zero', () => {
    const t = twoProportionZTest({ impressions: 0, clicks: 0, ctr: 0 }, { impressions: 10, clicks: 1, ctr: 0.1 });
    expect(t.pValue).toBe(1);
    expect(t.significant).toBe(false);
  });
});

describe('compareVariants — refuses winners the data cannot support', () => {
  const V = (variant: string, impressions: number, ctr: number): VariantSample =>
    ({ variant, impressions, ctr, clicks: Math.round(impressions * ctr) });

  it('declares a winner on a big, well-sampled difference — and always attaches the caveat', () => {
    const r = compareVariants([V('A', 50_000, 0.06), V('B', 50_000, 0.04)]);
    expect(r.verdict).toBe('winner');
    if (r.verdict === 'winner') {
      expect(r.variant).toBe('A');
      expect(r.lift).toBeCloseTo(0.5, 2);
      expect(r.caveat).toMatch(/SEQUENTIAL/);
      expect(r.caveat).toMatch(/NOT a concurrent split test/);
    }
  });

  it('is INCONCLUSIVE when impressions are too few, however big the gap looks', () => {
    // 20% vs 4% — a huge apparent difference on 100 impressions. Still noise.
    const r = compareVariants([V('A', 100, 0.20), V('B', 100, 0.04)]);
    expect(r.verdict).toBe('inconclusive');
    if (r.verdict === 'inconclusive') expect(r.reason).toMatch(/too few/);
  });

  it('is INCONCLUSIVE when a well-sampled difference is not significant', () => {
    const r = compareVariants([V('A', 50_000, 0.0402), V('B', 50_000, 0.04)]);
    expect(r.verdict).toBe('inconclusive');
    if (r.verdict === 'inconclusive') {
      expect(r.reason).toMatch(/noise/);
      expect(r.pValue).toBeGreaterThan(0.05);
    }
  });

  it('is INCONCLUSIVE with fewer than two measured variants', () => {
    expect(compareVariants([V('A', 50_000, 0.06)]).verdict).toBe('inconclusive');
    expect(compareVariants([V('A', 50_000, 0.06), V('B', 0, 0)]).verdict).toBe('inconclusive');
  });

  it('requires BOTH variants to clear the impression floor', () => {
    const r = compareVariants([V('A', 50_000, 0.06), V('B', MIN_IMPRESSIONS_FOR_VERDICT - 1, 0.02)]);
    expect(r.verdict).toBe('inconclusive');
    if (r.verdict === 'inconclusive') expect(r.reason).toContain('B');
  });
});
