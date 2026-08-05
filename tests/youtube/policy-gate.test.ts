/**
 * Tests for the pre-publish policy gate (GAP-03).
 *
 * The gate exists because YouTube enforces the inauthentic-content policy at the
 * CHANNEL level, so a templated batch endangers the whole back catalogue. The
 * tests therefore focus on two things: that near-duplicate scripts are caught,
 * and that no failure mode produces a `pass`.
 */

import { describe, it, expect } from 'vitest';
import {
  assessPublishCandidate,
  mayPublish,
  similarity,
  shingles,
  type PublishedVideo,
} from '../../src/core/youtube/policy-gate.js';

const LONG = (seed: string) =>
  `${seed} ` +
  'Compound interest is the mechanism by which a modest balance becomes a large one given enough ' +
  'time. The arithmetic is unforgiving in both directions: the same curve that rewards patience ' +
  'punishes borrowed money. In this video we walk through three worked examples, starting with a ' +
  'monthly contribution held for thirty years, then the same contribution interrupted by a five ' +
  'year gap, and finally the case most people actually face, which is contributing while also ' +
  'carrying revolving debt at a higher rate than the portfolio returns.';

const GOOD = {
  title: 'Compound interest, three worked examples',
  script: LONG('An honest look at what compounding does and does not do.'),
};

describe('similarity', () => {
  it('scores identical text as 1 and unrelated text near 0', () => {
    expect(similarity('the quick brown fox jumps', 'the quick brown fox jumps')).toBe(1);
    expect(similarity('alpha beta gamma delta', 'zulu yankee xray whiskey')).toBe(0);
  });

  it('ignores case and punctuation', () => {
    expect(similarity('Hello, world! This is fine.', 'hello world this is fine')).toBe(1);
  });

  it('builds word trigrams and degrades gracefully on short text', () => {
    expect(shingles('one two three four')).toEqual(new Set(['one two three', 'two three four']));
    expect(shingles('hi there')).toEqual(new Set(['hi there']));
    expect(shingles('')).toEqual(new Set());
    expect(similarity('', 'anything at all')).toBe(0);
  });
});

describe('assessPublishCandidate — structural checks', () => {
  it('passes an original, substantive script with no corpus', async () => {
    const a = await assessPublishCandidate(GOOD);
    expect(a.verdict).toBe('pass');
    expect(mayPublish(a)).toBe(true);
    expect(a.reasons).toEqual([]);
  });

  it('blocks an empty script', async () => {
    const a = await assessPublishCandidate({ title: 'A title', script: '   ' });
    expect(a.verdict).toBe('block');
    expect(a.reasons.join(' ')).toMatch(/empty/i);
  });

  it('blocks a script too thin to be anything but a slideshow', async () => {
    const a = await assessPublishCandidate({ title: 'Quick tip', script: 'Buy low. Sell high. Like and subscribe.' });
    expect(a.verdict).toBe('block');
    expect(a.reasons.join(' ')).toMatch(/slideshow/i);
  });

  it('blocks an over-length title rather than silently truncating it', async () => {
    const a = await assessPublishCandidate({ ...GOOD, title: 'x'.repeat(101) });
    expect(a.verdict).toBe('block');
    expect(a.reasons.join(' ')).toMatch(/100/);
  });

  it('blocks an empty title', async () => {
    const a = await assessPublishCandidate({ ...GOOD, title: '' });
    expect(a.verdict).toBe('block');
  });
});

describe('assessPublishCandidate — cross-video sameness', () => {
  const corpus: PublishedVideo[] = [
    { videoId: 'vid-old-1', title: 'Compound interest explained', script: LONG('An honest look at what compounding does and does not do.') },
    { videoId: 'vid-old-2', title: 'Something else entirely', script: LONG('A completely different subject about maritime navigation charts.') },
  ];

  it('blocks a near-duplicate of an already-published script', async () => {
    const a = await assessPublishCandidate(GOOD, corpus);
    expect(a.verdict).toBe('block');
    expect(a.similarityScore).toBeGreaterThan(0.6);
    expect(a.nearestVideoId).toBe('vid-old-1');
    expect(a.reasons.join(' ')).toMatch(/channel-wide/);
  });

  it('passes a genuinely different script against the same corpus', async () => {
    const fresh = {
      title: 'Why index funds beat stock picking for most people',
      script:
        'Active managers underperform their benchmarks over long horizons with remarkable ' +
        'consistency, and the reason is arithmetic rather than incompetence. Every trade has a ' +
        'counterparty, fees accrue regardless of outcome, and the median dollar under management ' +
        'must by definition earn the market return before costs. What follows is a look at the ' +
        'SPIVA data across fifteen years, the survivorship bias that flatters published records, ' +
        'and the narrow circumstances where active selection still makes defensible sense.',
    };
    const a = await assessPublishCandidate(fresh, corpus);
    expect(a.verdict).toBe('pass');
    expect(a.similarityScore).toBeLessThan(0.6);
  });

  it('honours a stricter threshold', async () => {
    const fresh = { title: 'Index funds', script: LONG('Different opening line about passive investing entirely.') };
    expect((await assessPublishCandidate(fresh, corpus, { similarityThreshold: 0.99 })).verdict).toBe('pass');
    expect((await assessPublishCandidate(fresh, corpus, { similarityThreshold: 0.1 })).verdict).toBe('block');
  });
});

describe('assessPublishCandidate — judge, and failing closed', () => {
  it('blocks when the judge rejects the candidate', async () => {
    const a = await assessPublishCandidate(GOOD, [], {
      judge: async () => ({ original: false, reason: 'Reads as a filled-in template.' }),
    });
    expect(a.verdict).toBe('block');
    expect(a.reasons[0]).toMatch(/filled-in template/);
  });

  it('HOLDS — never passes — when the judge throws', async () => {
    const a = await assessPublishCandidate(GOOD, [], {
      judge: async () => {
        throw new Error('judge route unavailable');
      },
    });
    expect(a.verdict).toBe('hold');
    expect(mayPublish(a)).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/fails closed/);
  });

  it('passes when the judge approves', async () => {
    const a = await assessPublishCandidate(GOOD, [], {
      judge: async () => ({ original: true, reason: 'Distinct framing and substantive detail.' }),
    });
    expect(a.verdict).toBe('pass');
  });

  it('short-circuits before the judge when a structural check already failed', async () => {
    let judgeCalled = false;
    const a = await assessPublishCandidate({ title: '', script: '' }, [], {
      judge: async () => {
        judgeCalled = true;
        return { original: true, reason: '' };
      },
    });
    expect(a.verdict).toBe('block');
    expect(judgeCalled).toBe(false);
  });
});

describe('mayPublish', () => {
  it('only approves an explicit pass', () => {
    expect(mayPublish({ verdict: 'pass', reasons: [], similarityScore: 0 })).toBe(true);
    expect(mayPublish({ verdict: 'hold', reasons: [], similarityScore: 0 })).toBe(false);
    expect(mayPublish({ verdict: 'block', reasons: [], similarityScore: 0 })).toBe(false);
  });
});
