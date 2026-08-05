/**
 * @file ypp-readiness.ts
 * @description YouTube Partner Program readiness tracking (GAP-06).
 *
 * Nothing tracked progress toward monetisation. Every input already existed in
 * the working `social.youtube-analytics` tool; what was missing was the model
 * that turns those numbers into "how far away are we, and when".
 *
 * ## The thing that makes this honest rather than misleading
 *
 * Three YPP requirements have **no API whatsoever** (audit Gate 2):
 *   - two-step verification enabled
 *   - a linked AdSense account
 *   - no active Community Guidelines strikes
 *
 * They are Studio/account-settings state. A readiness model that quietly assumed
 * them satisfied would report ELIGIBLE for a channel that YouTube will refuse —
 * the worst possible failure for this feature, because it triggers a human to go
 * click Apply and be rejected. So they are first-class criteria with status
 * `human-verify`, and **overall readiness can never reach `eligible` while any
 * remains unconfirmed** — the best it reports is `thresholds-met`.
 *
 * Thresholds verified 2026-08-01 against Google's published eligibility docs.
 */

/** Full monetisation (ad revenue). */
export const YPP_SUBSCRIBERS = 1_000;
export const YPP_WATCH_HOURS = 4_000;      // public, trailing 12 months
export const YPP_SHORTS_VIEWS = 10_000_000; // valid, trailing 90 days

/** Early access — fan funding only, NO ad revenue. */
export const YPP_EARLY_SUBSCRIBERS = 500;
export const YPP_EARLY_WATCH_HOURS = 3_000;
export const YPP_EARLY_SHORTS_VIEWS = 3_000_000;
export const YPP_EARLY_MIN_UPLOADS = 3;    // public uploads in last 90 days

export type CriterionStatus = 'met' | 'not-met' | 'human-verify';

export interface Criterion {
  id: string;
  label: string;
  status: CriterionStatus;
  current: number | null;
  target: number | null;
  /** Set for measurable criteria that are not yet met. */
  remaining?: number;
  note?: string;
}

/**
 * Measured channel metrics. `null` means *not measured*, which is deliberately
 * distinct from `0` — an unmeasured metric must never read as "no progress".
 */
export interface YppMetrics {
  subscribers: number | null;
  /** Public watch hours, trailing 12 months. */
  watchHours12mo: number | null;
  /** Valid Shorts views, trailing 90 days. */
  shortsViews90d: number | null;
  /** Public uploads in the last 90 days. */
  uploads90d: number | null;
  /** Growth rates for projection; null when unknown. */
  subscribersPerDay?: number | null;
  watchHoursPerDay?: number | null;
  /** Operator attestations for the API-invisible requirements. */
  twoStepVerified?: boolean;
  adsenseLinked?: boolean;
  noActiveStrikes?: boolean;
}

export type ReadinessVerdict =
  | 'eligible'          // thresholds met AND all human criteria confirmed
  | 'thresholds-met'    // numbers there, human criteria unconfirmed
  | 'early-access'      // early-access thresholds met, not full
  | 'building'          // on the way
  | 'unknown';          // nothing measurable

export interface YppReadiness {
  verdict: ReadinessVerdict;
  /** 0..1 across the measurable full-monetisation thresholds. */
  progress: number;
  criteria: Criterion[];
  /** Which path is closer — long-form watch hours or Shorts views. */
  path: 'watch-hours' | 'shorts' | 'undetermined';
  /** ISO date, or null when growth is unknown / non-positive. */
  projectedEligibleDate: string | null;
  /** What the operator should do now. Always populated. */
  action: string;
}

// ---------------------------------------------------------------------------

function criterion(
  id: string,
  label: string,
  current: number | null,
  target: number,
): Criterion {
  if (current === null) {
    return { id, label, status: 'not-met', current: null, target, note: 'not measured' };
  }
  const met = current >= target;
  return {
    id, label, status: met ? 'met' : 'not-met', current, target,
    ...(met ? {} : { remaining: target - current }),
  };
}

function humanCriterion(id: string, label: string, confirmed: boolean | undefined): Criterion {
  return {
    id, label,
    status: confirmed === true ? 'met' : 'human-verify',
    current: null, target: null,
    note: confirmed === true
      ? 'confirmed by operator'
      : 'NO API EXPOSES THIS — an operator must confirm it in YouTube Studio / AdSense',
  };
}

/**
 * Days until a metric reaches its target at the observed rate.
 * Returns null when the rate is unknown or non-positive — "never at this rate"
 * is information, and a fabricated date would be worse than none.
 */
export function daysToTarget(current: number, target: number, perDay: number | null | undefined): number | null {
  if (current >= target) return 0;
  if (perDay === null || perDay === undefined || perDay <= 0) return null;
  return Math.ceil((target - current) / perDay);
}

/** Assess readiness from measured metrics. Pure — no I/O, fully testable. */
export function assessYppReadiness(m: YppMetrics, now: Date = new Date()): YppReadiness {
  const subs = criterion('subscribers', 'Subscribers', m.subscribers, YPP_SUBSCRIBERS);
  const hours = criterion('watch_hours', 'Public watch hours (12mo)', m.watchHours12mo, YPP_WATCH_HOURS);
  const shorts = criterion('shorts_views', 'Valid Shorts views (90d)', m.shortsViews90d, YPP_SHORTS_VIEWS);

  const human = [
    humanCriterion('two_step', 'Two-step verification enabled', m.twoStepVerified),
    humanCriterion('adsense', 'AdSense account linked', m.adsenseLinked),
    humanCriterion('no_strikes', 'No active Community Guidelines strikes', m.noActiveStrikes),
  ];

  const criteria = [subs, hours, shorts, ...human];

  // Either watch-hours OR Shorts satisfies the second requirement.
  const hoursFrac = m.watchHours12mo === null ? 0 : Math.min(1, m.watchHours12mo / YPP_WATCH_HOURS);
  const shortsFrac = m.shortsViews90d === null ? 0 : Math.min(1, m.shortsViews90d / YPP_SHORTS_VIEWS);
  const path: YppReadiness['path'] =
    m.watchHours12mo === null && m.shortsViews90d === null ? 'undetermined'
      : hoursFrac >= shortsFrac ? 'watch-hours' : 'shorts';

  const subsFrac = m.subscribers === null ? 0 : Math.min(1, m.subscribers / YPP_SUBSCRIBERS);
  const progress = (subsFrac + Math.max(hoursFrac, shortsFrac)) / 2;

  const thresholdsMet = subs.status === 'met' && (hours.status === 'met' || shorts.status === 'met');
  const humanAllConfirmed = human.every((c) => c.status === 'met');

  const earlyMet =
    (m.subscribers ?? 0) >= YPP_EARLY_SUBSCRIBERS &&
    (m.uploads90d ?? 0) >= YPP_EARLY_MIN_UPLOADS &&
    ((m.watchHours12mo ?? 0) >= YPP_EARLY_WATCH_HOURS || (m.shortsViews90d ?? 0) >= YPP_EARLY_SHORTS_VIEWS);

  const nothingMeasured =
    m.subscribers === null && m.watchHours12mo === null && m.shortsViews90d === null;

  let verdict: ReadinessVerdict;
  if (nothingMeasured) verdict = 'unknown';
  else if (thresholdsMet && humanAllConfirmed) verdict = 'eligible';
  else if (thresholdsMet) verdict = 'thresholds-met';
  else if (earlyMet) verdict = 'early-access';
  else verdict = 'building';

  // Projection: the binding constraint is whichever takes longer.
  const dSubs = daysToTarget(m.subscribers ?? 0, YPP_SUBSCRIBERS, m.subscribersPerDay);
  const dHours = daysToTarget(m.watchHours12mo ?? 0, YPP_WATCH_HOURS, m.watchHoursPerDay);
  let projectedEligibleDate: string | null = null;
  if (dSubs !== null && dHours !== null) {
    const d = new Date(now.getTime() + Math.max(dSubs, dHours) * 86_400_000);
    projectedEligibleDate = d.toISOString().slice(0, 10);
  }

  const unconfirmed = human.filter((c) => c.status !== 'met').map((c) => c.label);
  let action: string;
  switch (verdict) {
    case 'eligible':
      action = 'APPLY NOW — thresholds met and all account requirements confirmed. ' +
        'The application itself is Studio-only and must be done by a human.';
      break;
    case 'thresholds-met':
      action = `Thresholds are met, but ${unconfirmed.length} account requirement(s) cannot be ` +
        `checked by any API and remain unconfirmed: ${unconfirmed.join(', ')}. ` +
        'Confirm them in YouTube Studio / AdSense before applying.';
      break;
    case 'early-access':
      action = 'Early-access thresholds met — unlocks fan funding (Super Thanks, memberships, ' +
        'shopping) but NOT ad revenue. Full monetisation still needs 1,000 subs.';
      break;
    case 'unknown':
      action = 'No metrics measured — check the Analytics credential before trusting any readiness figure.';
      break;
    default: {
      const parts: string[] = [];
      if (subs.remaining) parts.push(`${subs.remaining.toLocaleString()} more subscribers`);
      if (path === 'shorts' && shorts.remaining) parts.push(`${shorts.remaining.toLocaleString()} more Shorts views`);
      else if (hours.remaining) parts.push(`${hours.remaining.toLocaleString()} more watch hours`);
      action = `Building: needs ${parts.join(' and ')}.` +
        (projectedEligibleDate ? ` Projected ${projectedEligibleDate} at the current rate.` : ' Growth rate unknown — no projection.');
    }
  }

  return { verdict, progress, criteria, path, projectedEligibleDate, action };
}

/** True when the operator should be alerted (state worth acting on). */
export function shouldAlert(r: YppReadiness): boolean {
  return r.verdict === 'eligible' || r.verdict === 'thresholds-met' || r.verdict === 'early-access';
}
