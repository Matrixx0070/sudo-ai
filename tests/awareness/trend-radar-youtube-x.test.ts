/**
 * Tests for the YouTube and X trend scanners.
 *
 * The two properties that matter most are cost properties: the YouTube scanner
 * must use the 1-unit `videos.list` chart and never the 100-unit `search.list`
 * (GAP-02), and the X scanner must cost nothing unless an operator has
 * deliberately supplied a paid credential.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  scanYouTubeTrending,
  scanXTrends,
  WOEID_WORLDWIDE,
  type QuotaSpender,
} from '../../src/core/awareness/trend-radar-scanners.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env['YOUTUBE_API_KEY'];
  delete process.env['X_API_BEARER_TOKEN'];
});

function mockFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response);
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

const YT_PAYLOAD = {
  items: [
    {
      id: 'abc123',
      snippet: {
        title: 'How compound interest actually works',
        channelTitle: 'Some Finance Channel',
        categoryId: '25',
        publishedAt: '2026-07-31T10:00:00Z',
      },
      statistics: { viewCount: '1250000', likeCount: '48000', commentCount: '3100' },
    },
    { id: 'no-title', snippet: {}, statistics: { viewCount: '5' } },
  ],
};

describe('scanYouTubeTrending', () => {
  it('maps the trending chart into TrendItems with real view counts', async () => {
    mockFetch(YT_PAYLOAD);
    const items = await scanYouTubeTrending({ apiKey: 'k' });

    expect(items).toHaveLength(1); // the title-less entry is dropped
    expect(items[0]).toMatchObject({
      id: 'yt-abc123',
      title: 'How compound interest actually works',
      source: 'youtube',
      url: 'https://youtube.com/watch?v=abc123',
      score: 1_250_000,
      category: '25',
      matchesNiche: false,
    });
    expect(items[0]!.metadata).toMatchObject({
      channelTitle: 'Some Finance Channel',
      likeCount: 48_000,
      commentCount: 3_100,
      regionCode: 'US',
    });
  });

  it('uses the 1-unit mostPopular chart and never the 100-unit search endpoint', async () => {
    const fn = mockFetch(YT_PAYLOAD);
    await scanYouTubeTrending({ apiKey: 'k', regionCode: 'GB', categoryId: '28' });

    const url = String(fn.mock.calls[0]![0]);
    expect(url).toContain('/youtube/v3/videos');
    expect(url).toContain('chart=mostPopular');
    expect(url).toContain('regionCode=GB');
    expect(url).toContain('videoCategoryId=28');
    // The quota bomb must not appear.
    expect(url).not.toContain('/search');
  });

  it('makes exactly one request — it never paginates', async () => {
    const fn = mockFetch(YT_PAYLOAD);
    await scanYouTubeTrending({ apiKey: 'k', maxResults: 50 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clamps maxResults to the API maximum of 50', async () => {
    const fn = mockFetch(YT_PAYLOAD);
    await scanYouTubeTrending({ apiKey: 'k', maxResults: 500 });
    expect(String(fn.mock.calls[0]![0])).toContain('maxResults=50');
  });

  it('charges exactly one videos.list unit against the ledger', async () => {
    mockFetch(YT_PAYLOAD);
    const spend = vi.fn();
    await scanYouTubeTrending({ apiKey: 'k', ledger: { spend } as QuotaSpender });
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledWith('videos.list');
  });

  it('charges before the request, so a failed call still costs quota', async () => {
    const order: string[] = [];
    globalThis.fetch = (async () => {
      order.push('fetch');
      throw new Error('network down');
    }) as unknown as typeof globalThis.fetch;

    const items = await scanYouTubeTrending({
      apiKey: 'k',
      ledger: { spend: () => void order.push('spend') } as QuotaSpender,
    });
    expect(order).toEqual(['spend', 'fetch']);
    expect(items).toEqual([]);
  });

  it('skips the scan entirely when the ledger refuses the spend', async () => {
    const fn = mockFetch(YT_PAYLOAD);
    const items = await scanYouTubeTrending({
      apiKey: 'k',
      ledger: {
        spend: () => {
          throw new Error('quota exhausted');
        },
      } as QuotaSpender,
    });
    expect(items).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns [] without a key rather than throwing', async () => {
    const fn = mockFetch(YT_PAYLOAD);
    expect(await scanYouTubeTrending({})).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('reads YOUTUBE_API_KEY from the environment', async () => {
    process.env['YOUTUBE_API_KEY'] = 'env-key';
    const fn = mockFetch(YT_PAYLOAD);
    await scanYouTubeTrending({});
    expect(String(fn.mock.calls[0]![0])).toContain('key=env-key');
  });

  it('degrades to [] on an API error instead of taking down the whole scan', async () => {
    mockFetch({ error: { message: 'quotaExceeded' } }, false, 403);
    expect(await scanYouTubeTrending({ apiKey: 'k' })).toEqual([]);
  });

  it('tolerates a response with no items array', async () => {
    mockFetch({});
    expect(await scanYouTubeTrending({ apiKey: 'k' })).toEqual([]);
  });
});

describe('scanXTrends — paid, opt-in only', () => {
  it('costs nothing and makes no call without a token', async () => {
    const fn = mockFetch({ data: [] });
    expect(await scanXTrends({})).toEqual([]);
    expect(fn, 'X is a paid endpoint — it must not be called by default').not.toHaveBeenCalled();
  });

  it('maps trends when a token is supplied', async () => {
    const fn = mockFetch({
      data: [
        { trend_name: 'Federal Reserve', tweet_count: 120_000 },
        { trend_name: '  ', tweet_count: 5 },
      ],
    });
    const items = await scanXTrends({ bearerToken: 'tok' });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'x-federal-reserve',
      title: 'Federal Reserve',
      source: 'x',
      score: 120_000,
    });
    const [, init] = fn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect(String(fn.mock.calls[0]![0])).toContain(`/${WOEID_WORLDWIDE}`);
  });

  it('returns [] rather than guessing when the response shape is unrecognised', async () => {
    mockFetch({ unexpected: 'shape' });
    expect(await scanXTrends({ bearerToken: 'tok' })).toEqual([]);
  });

  it('degrades to [] on a non-OK response', async () => {
    mockFetch({ title: 'Unauthorized' }, false, 401);
    expect(await scanXTrends({ bearerToken: 'tok' })).toEqual([]);
  });

  it('defaults tweet_count to 0 when absent rather than inventing a number', async () => {
    mockFetch({ data: [{ trend_name: 'Something' }] });
    const items = await scanXTrends({ bearerToken: 'tok' });
    expect(items[0]!.score).toBe(0);
  });
});

describe('scanReddit — a dead source must be loud (403 verified live on 2026-08-01)', () => {
  it('degrades to [] without throwing when every subreddit is blocked', async () => {
    // Reddit blocks datacenter IPs on the public .json endpoints. Previously
    // every failure logged at debug and the scanner returned an empty array, so
    // the source died silently. The scanner now emits a WARN naming the 403;
    // that log line is asserted by the live probe in audit/06, not here —
    // intercepting the module's own pino instance from a unit test would test
    // the mock, not the behaviour. What IS locked in here is that a fully
    // blocked source degrades quietly to [] instead of throwing and killing
    // scanAll for the other sources.
    const { scanReddit } = await import('../../src/core/awareness/trend-radar-scanners.js');
    globalThis.fetch = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => 'Blocked',
    }) as unknown as Response) as unknown as typeof globalThis.fetch;

    await expect(scanReddit(['technology', 'programming'])).resolves.toEqual([]);
  });

  it('still returns items when Reddit responds normally', async () => {
    const { scanReddit } = await import('../../src/core/awareness/trend-radar-scanners.js');
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { children: [{ data: { id: 'p1', title: 'A post', score: 42, permalink: '/r/x/p1' } }] },
      }),
      text: async () => '',
    }) as unknown as Response) as unknown as typeof globalThis.fetch;

    const items = await scanReddit(['technology']);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'reddit-p1', source: 'reddit', score: 42 });
  });
});
