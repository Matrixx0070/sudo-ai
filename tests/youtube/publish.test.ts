/**
 * Tests for the publish orchestrator (GAP-03, the wiring half).
 *
 * The headline assertion is production-readiness gate 3 from audit/04-ROADMAP.md:
 * *"There is no code path from agent decision to videos.insert that bypasses the
 * policy gate. Verified by a test that asserts the bypass does not exist."*
 *
 * So the uploader here is a spy, and the tests care most about when it is NOT
 * called.
 */

import { describe, it, expect, vi } from 'vitest';
import { PublishStore, publishVideo, type Uploader } from '../../src/core/youtube/publish.js';

function store() {
  return new PublishStore(':memory:');
}

/** A spy uploader that always succeeds. */
function uploader(videoId = 'vid-new') {
  return vi.fn(async () => ({ success: true, videoId, output: 'ok' })) as unknown as Uploader &
    ReturnType<typeof vi.fn>;
}

const SCRIPT_A =
  'Compound interest is the mechanism by which a modest balance becomes a large one given enough ' +
  'time. The arithmetic is unforgiving in both directions: the same curve that rewards patience ' +
  'punishes borrowed money. We walk through three worked examples, starting with a monthly ' +
  'contribution held for thirty years, then the same contribution interrupted by a five year gap, ' +
  'and finally the case most people actually face, contributing while carrying revolving debt.';

const SCRIPT_B =
  'Active managers underperform their benchmarks over long horizons with remarkable consistency, ' +
  'and the reason is arithmetic rather than incompetence. Every trade has a counterparty, fees ' +
  'accrue regardless of outcome, and the median dollar under management must by definition earn ' +
  'the market return before costs. What follows is a look at fifteen years of SPIVA data, the ' +
  'survivorship bias that flatters published records, and where selection still makes sense.';

const REQ = { title: 'Compound interest, three worked examples', script: SCRIPT_A, videoPath: '/tmp/a.mp4' };

describe('PublishStore — the corpus the gate compares against', () => {
  it('starts empty, records, and returns newest first', () => {
    const s = store();
    expect(s.count()).toBe(0);
    s.record({ videoId: 'v1', title: 'One', script: SCRIPT_A });
    s.record({ videoId: 'v2', title: 'Two', script: SCRIPT_B });
    expect(s.count()).toBe(2);
    expect(s.recent(1)[0]!.videoId).toBe('v2');
    s.close();
  });

  it('upserts rather than duplicating on the same videoId', () => {
    const s = store();
    s.record({ videoId: 'v1', title: 'First', script: SCRIPT_A });
    s.record({ videoId: 'v1', title: 'Renamed', script: SCRIPT_A });
    expect(s.count()).toBe(1);
    expect(s.recent()[0]!.title).toBe('Renamed');
    s.close();
  });
});

describe('publishVideo — the gate cannot be bypassed', () => {
  it('publishes an original script and records it to the corpus', async () => {
    const s = store();
    const up = uploader('vid-1');
    const out = await publishVideo(REQ, { store: s, upload: up });

    expect(out.status).toBe('published');
    expect(up).toHaveBeenCalledTimes(1);
    expect(s.count()).toBe(1);
    expect(s.recent()[0]!.videoId).toBe('vid-1');
    s.close();
  });

  it('BLOCKS a near-duplicate of an already-published script and never calls the uploader', async () => {
    const s = store();
    s.record({ videoId: 'old-1', title: 'Compound interest explained', script: SCRIPT_A });
    const up = uploader();

    const out = await publishVideo(REQ, { store: s, upload: up });

    expect(out.status).toBe('blocked');
    expect(up, 'the uploader must never run on a blocked candidate').not.toHaveBeenCalled();
    expect(s.count()).toBe(1); // nothing new recorded
    if (out.status === 'blocked') expect(out.reasons.join(' ')).toMatch(/channel-wide/);
    s.close();
  });

  it('allows a genuinely different script against the same corpus', async () => {
    const s = store();
    s.record({ videoId: 'old-1', title: 'Compound interest', script: SCRIPT_A });
    const up = uploader('vid-2');

    const out = await publishVideo(
      { title: 'Why index funds beat stock picking', script: SCRIPT_B, videoPath: '/tmp/b.mp4' },
      { store: s, upload: up },
    );

    expect(out.status).toBe('published');
    expect(up).toHaveBeenCalledTimes(1);
    s.close();
  });

  it('HOLDS and does not upload when the judge throws — the gate fails closed', async () => {
    const s = store();
    const up = uploader();

    const out = await publishVideo(REQ, {
      store: s,
      upload: up,
      gate: { judge: async () => { throw new Error('judge route down'); } },
    });

    expect(out.status).toBe('held');
    expect(up, 'a judge outage must never result in a publish').not.toHaveBeenCalled();
    s.close();
  });

  it('BLOCKS on a thin script without calling the uploader', async () => {
    const s = store();
    const up = uploader();
    const out = await publishVideo(
      { title: 'Quick tip', script: 'Buy low. Sell high.', videoPath: '/tmp/c.mp4' },
      { store: s, upload: up },
    );
    expect(out.status).toBe('blocked');
    expect(up).not.toHaveBeenCalled();
    s.close();
  });

  it('does NOT record to the corpus when the upload itself fails', async () => {
    const s = store();
    const up = vi.fn(async () => ({ success: false, output: 'quota exhausted' })) as unknown as Uploader;

    const out = await publishVideo(REQ, { store: s, upload: up });

    expect(out.status).toBe('upload_failed');
    expect(s.count(), 'a failed upload must not poison future similarity checks').toBe(0);
    s.close();
  });

  it('defaults privacyStatus to private — going public must be deliberate', async () => {
    const s = store();
    const up = uploader();
    await publishVideo(REQ, { store: s, upload: up });
    expect((up as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ privacyStatus: 'private' });
    s.close();
  });

  it('always returns the assessment, including on a block, for audit', async () => {
    const s = store();
    s.record({ videoId: 'old-1', title: 'x', script: SCRIPT_A });
    const out = await publishVideo(REQ, { store: s, upload: uploader() });
    expect(out.assessment.similarityScore).toBeGreaterThan(0.6);
    expect(out.assessment.nearestVideoId).toBe('old-1');
    s.close();
  });

  it('compares against many prior videos, not just the newest', async () => {
    const s = store();
    s.record({ videoId: 'dup', title: 'the duplicate', script: SCRIPT_A });
    for (let i = 0; i < 10; i++) {
      s.record({ videoId: `filler-${i}`, title: `f${i}`, script: `${SCRIPT_B} variation ${i}` });
    }
    const up = uploader();
    const out = await publishVideo(REQ, { store: s, upload: up });

    expect(out.status).toBe('blocked');
    expect(up).not.toHaveBeenCalled();
    s.close();
  });
});

describe('source-level bypass check (roadmap gate 3)', () => {
  it('has exactly one uploader call site, and it is gated on the assessment', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/core/youtube/publish.ts', 'utf8');

    // The injected uploader must be invoked exactly once in the source.
    const callSites = [...src.matchAll(/opts\.upload\(/g)];
    expect(callSites, 'more than one upload call site is a bypass risk').toHaveLength(1);

    // And the guard must appear before it.
    const guardIdx = src.indexOf("assessment.verdict !== 'pass'");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(src.indexOf('opts.upload('));
  });
});
