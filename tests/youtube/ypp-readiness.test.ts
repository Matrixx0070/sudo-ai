/**
 * Tests for YPP readiness (GAP-06).
 *
 * The failure this feature must not have: reporting ELIGIBLE for a channel
 * YouTube will refuse. Three requirements (2SV, AdSense, no strikes) have no API
 * at all, so the tests below care most about the model refusing to claim
 * eligibility while those are unconfirmed.
 */

import { describe, it, expect } from 'vitest';
import {
  assessYppReadiness,
  daysToTarget,
  shouldAlert,
  YPP_SUBSCRIBERS,
  YPP_WATCH_HOURS,
  YPP_SHORTS_VIEWS,
  type YppMetrics,
} from '../../src/core/youtube/ypp-readiness.js';

const NOW = new Date('2026-08-02T00:00:00Z');

const M = (over: Partial<YppMetrics> = {}): YppMetrics => ({
  subscribers: 0, watchHours12mo: 0, shortsViews90d: 0, uploads90d: 0, ...over,
});

/** All three human-only requirements attested. */
const ATTESTED = { twoStepVerified: true, adsenseLinked: true, noActiveStrikes: true };

describe('the API-invisible requirements', () => {
  it('never reports ELIGIBLE while 2SV / AdSense / strikes are unconfirmed', () => {
    const r = assessYppReadiness(M({ subscribers: 5_000, watchHours12mo: 9_000 }), NOW);
    expect(r.verdict).toBe('thresholds-met');
    expect(r.verdict).not.toBe('eligible');
    expect(r.action).toMatch(/cannot be checked by any API/);
  });

  it('reaches ELIGIBLE only once all three are attested', () => {
    const r = assessYppReadiness(M({ subscribers: 5_000, watchHours12mo: 9_000, ...ATTESTED }), NOW);
    expect(r.verdict).toBe('eligible');
    expect(r.action).toMatch(/APPLY NOW/);
    expect(r.action).toMatch(/must be done by a human/);
  });

  it('holds back if even one attestation is missing', () => {
    for (const missing of ['twoStepVerified', 'adsenseLinked', 'noActiveStrikes'] as const) {
      const attest = { ...ATTESTED, [missing]: false };
      const r = assessYppReadiness(M({ subscribers: 5_000, watchHours12mo: 9_000, ...attest }), NOW);
      expect(r.verdict, `${missing} unconfirmed must block eligibility`).toBe('thresholds-met');
    }
  });

  it('marks them human-verify with an explicit note, not silently met', () => {
    const r = assessYppReadiness(M(), NOW);
    const human = r.criteria.filter((c) => c.status === 'human-verify');
    expect(human).toHaveLength(3);
    for (const c of human) expect(c.note).toMatch(/NO API EXPOSES THIS/);
  });
});

describe('threshold logic', () => {
  it('accepts EITHER watch hours or Shorts views', () => {
    const viaHours = assessYppReadiness(M({ subscribers: 1_000, watchHours12mo: YPP_WATCH_HOURS, ...ATTESTED }), NOW);
    const viaShorts = assessYppReadiness(M({ subscribers: 1_000, shortsViews90d: YPP_SHORTS_VIEWS, ...ATTESTED }), NOW);
    expect(viaHours.verdict).toBe('eligible');
    expect(viaShorts.verdict).toBe('eligible');
    expect(viaShorts.path).toBe('shorts');
    expect(viaHours.path).toBe('watch-hours');
  });

  it('requires subscribers regardless of the other path', () => {
    const r = assessYppReadiness(M({ subscribers: 999, watchHours12mo: 50_000, ...ATTESTED }), NOW);
    expect(r.verdict).toBe('building');
    expect(r.criteria.find((c) => c.id === 'subscribers')!.remaining).toBe(1);
  });

  it('is exact at the boundary', () => {
    const at = assessYppReadiness(M({ subscribers: YPP_SUBSCRIBERS, watchHours12mo: YPP_WATCH_HOURS, ...ATTESTED }), NOW);
    expect(at.verdict).toBe('eligible');
    const below = assessYppReadiness(M({ subscribers: YPP_SUBSCRIBERS, watchHours12mo: YPP_WATCH_HOURS - 1, ...ATTESTED }), NOW);
    expect(below.verdict).toBe('building');
  });

  it('detects early access and is explicit that it is NOT ad revenue', () => {
    const r = assessYppReadiness(M({ subscribers: 600, watchHours12mo: 3_200, uploads90d: 5 }), NOW);
    expect(r.verdict).toBe('early-access');
    expect(r.action).toMatch(/NOT ad revenue/);
  });

  it('does not claim early access without the 3-upload requirement', () => {
    const r = assessYppReadiness(M({ subscribers: 600, watchHours12mo: 3_200, uploads90d: 2 }), NOW);
    expect(r.verdict).toBe('building');
  });
});

describe('unmeasured is not zero', () => {
  it('reports UNKNOWN when nothing was measured, rather than "no progress"', () => {
    const r = assessYppReadiness(
      { subscribers: null, watchHours12mo: null, shortsViews90d: null, uploads90d: null }, NOW);
    expect(r.verdict).toBe('unknown');
    expect(r.path).toBe('undetermined');
    expect(r.action).toMatch(/check the Analytics credential/);
  });

  it('notes a null metric as "not measured" rather than met', () => {
    const r = assessYppReadiness(M({ subscribers: null }), NOW);
    expect(r.criteria.find((c) => c.id === 'subscribers')!.note).toBe('not measured');
  });
});

describe('projection', () => {
  it('computes days to target at the observed rate', () => {
    expect(daysToTarget(0, 100, 10)).toBe(10);
    expect(daysToTarget(90, 100, 3)).toBe(4);   // ceil
    expect(daysToTarget(100, 100, 5)).toBe(0);
  });

  it('returns null rather than a fabricated date when growth is flat or unknown', () => {
    expect(daysToTarget(0, 100, 0)).toBeNull();
    expect(daysToTarget(0, 100, -5)).toBeNull();
    expect(daysToTarget(0, 100, null)).toBeNull();
    expect(daysToTarget(0, 100, undefined)).toBeNull();
  });

  it('projects from the SLOWER of the two constraints', () => {
    const r = assessYppReadiness(M({
      subscribers: 900, subscribersPerDay: 10,      // 10 days
      watchHours12mo: 3_900, watchHoursPerDay: 10,  // 10 days
    }), NOW);
    expect(r.projectedEligibleDate).toBe('2026-08-12');

    const slower = assessYppReadiness(M({
      subscribers: 900, subscribersPerDay: 10,      // 10 days
      watchHours12mo: 3_000, watchHoursPerDay: 10,  // 100 days -> binding
    }), NOW);
    expect(slower.projectedEligibleDate).toBe('2026-11-10');
  });

  it('gives no projection when growth is unknown, and says so', () => {
    const r = assessYppReadiness(M({ subscribers: 900, watchHours12mo: 3_900 }), NOW);
    expect(r.projectedEligibleDate).toBeNull();
    expect(r.action).toMatch(/no projection/);
  });
});

describe('progress + alerting', () => {
  it('reports 0 at the start and 1 at the thresholds', () => {
    expect(assessYppReadiness(M(), NOW).progress).toBe(0);
    expect(assessYppReadiness(M({ subscribers: YPP_SUBSCRIBERS, watchHours12mo: YPP_WATCH_HOURS }), NOW).progress).toBe(1);
  });

  it('does not exceed 1 when a threshold is overshot', () => {
    const r = assessYppReadiness(M({ subscribers: 100_000, watchHours12mo: 900_000 }), NOW);
    expect(r.progress).toBe(1);
  });

  it('alerts on actionable states only', () => {
    expect(shouldAlert(assessYppReadiness(M({ subscribers: 5_000, watchHours12mo: 9_000, ...ATTESTED }), NOW))).toBe(true);
    expect(shouldAlert(assessYppReadiness(M({ subscribers: 5_000, watchHours12mo: 9_000 }), NOW))).toBe(true);
    expect(shouldAlert(assessYppReadiness(M({ subscribers: 10 }), NOW))).toBe(false);
  });

  it('tells the operator exactly what is missing while building', () => {
    const r = assessYppReadiness(M({ subscribers: 400, watchHours12mo: 1_000 }), NOW);
    expect(r.action).toMatch(/600 more subscribers/);
    expect(r.action).toMatch(/3,000 more watch hours/);
  });
});
