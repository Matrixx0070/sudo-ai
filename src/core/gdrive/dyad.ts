/**
 * @file gdrive/dyad.ts
 * @description F66 (dyad health audit + stats appendix) and F49 (operator
 * calibration — blind spots). Both read the timestamped `corrections` dataset
 * (F26): F66 measures the agent↔principal relationship over time (are
 * corrections trending down = healthier, or up = friction?), and F49 surfaces
 * PERSISTENT blind spots — themes the principal keeps correcting across both an
 * older and a recent window, i.e. lessons that never stuck.
 *
 * Pure/local (dataset read only). The rendered reports become zone-2 shapes;
 * every correction snippet is screened at broadcast time (shapes-n3.ts).
 */

import { readDataset } from './datasets.js';
import { contentWords } from './error-atlas.js';

interface CorrectionRow {
  doc?: string;
  correction?: string;
  directive?: boolean;
  marker?: string | null;
  _at?: string;
}

const DAY_MS = 24 * 3600_000;

function rows(): Array<Required<Pick<CorrectionRow, 'correction'>> & CorrectionRow> {
  return readDataset<CorrectionRow>('corrections').filter(
    (r): r is CorrectionRow & { correction: string } => typeof r.correction === 'string',
  );
}

function ageDays(at: string | undefined, now: number): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? (now - t) / DAY_MS : null;
}

// ---------------------------------------------------------------------------
// F66 — dyad health audit
// ---------------------------------------------------------------------------

export interface DyadStats {
  total: number;
  last7: number;
  last30: number;
  prev30: number; // days 30–60
  trend: 'improving' | 'worsening' | 'stable';
  directiveShare: number;
  distinctDocs: number;
  markers: Record<string, number>;
}

export function buildDyadStats(now: () => number = () => Date.now()): DyadStats {
  const t = now();
  const all = rows();
  let last7 = 0, last30 = 0, prev30 = 0, directives = 0;
  const docs = new Set<string>();
  const markers: Record<string, number> = {};
  for (const r of all) {
    const age = ageDays(r._at, t);
    if (age !== null) {
      if (age <= 7) last7++;
      if (age <= 30) last30++;
      else if (age <= 60) prev30++;
    }
    if (r.directive) directives++;
    if (r.doc) docs.add(r.doc);
    if (r.marker) markers[r.marker] = (markers[r.marker] ?? 0) + 1;
  }
  // Healthier = fewer corrections recently than in the prior window.
  let trend: DyadStats['trend'] = 'stable';
  if (last30 < prev30) trend = 'improving';
  else if (last30 > prev30) trend = 'worsening';
  return {
    total: all.length,
    last7,
    last30,
    prev30,
    trend,
    directiveShare: all.length ? directives / all.length : 0,
    distinctDocs: docs.size,
    markers,
  };
}

export function renderDyadHealthReport(stats: DyadStats): string {
  const lines = [
    '# Dyad health audit (F66)',
    '',
    `Relationship signal from ${stats.total} principal correction(s).`,
    '',
    `**Trend: ${stats.trend}** (last 30d: ${stats.last30}, prior 30d: ${stats.prev30}).`,
    '',
    '## Stats appendix',
    `- corrections, last 7d: ${stats.last7}`,
    `- corrections, last 30d: ${stats.last30}`,
    `- corrections, prior 30d (30–60d): ${stats.prev30}`,
    `- directive share: ${(stats.directiveShare * 100).toFixed(0)}%`,
    `- distinct documents corrected: ${stats.distinctDocs}`,
    `- by source marker: ${Object.keys(stats.markers).length ? Object.entries(stats.markers).map(([k, v]) => `${k}=${v}`).join(', ') : '(none)'}`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// F49 — operator calibration (persistent blind spots)
// ---------------------------------------------------------------------------

export interface BlindSpot {
  theme: string;
  total: number;
  recent: number; // ≤ recentDays
  older: number; // > recentDays
  persistent: boolean; // seen in BOTH windows → never stuck
}

/**
 * A blind spot is PERSISTENT when the principal corrected the same theme in
 * both the recent and the older window — the calibration gap that isn't
 * closing. Ranked persistent-first, then by total.
 */
export function buildBlindSpots(
  opts: { recentDays?: number; minTotal?: number; now?: () => number } = {},
): BlindSpot[] {
  const recentDays = opts.recentDays ?? 30;
  const minTotal = opts.minTotal ?? 2;
  const t = (opts.now ?? (() => Date.now()))();
  const agg = new Map<string, { total: number; recent: number; older: number }>();
  for (const r of rows()) {
    const age = ageDays(r._at, t);
    const isRecent = age !== null && age <= recentDays;
    for (const term of new Set(contentWords(r.correction))) {
      let a = agg.get(term);
      if (!a) { a = { total: 0, recent: 0, older: 0 }; agg.set(term, a); }
      a.total++;
      if (isRecent) a.recent++;
      else a.older++;
    }
  }
  return [...agg.entries()]
    .filter(([, a]) => a.total >= minTotal)
    .map(([theme, a]) => ({ theme, total: a.total, recent: a.recent, older: a.older, persistent: a.recent > 0 && a.older > 0 }))
    .sort((x, y) => Number(y.persistent) - Number(x.persistent) || y.total - x.total || x.theme.localeCompare(y.theme));
}

export function renderBlindSpotsReport(spots: BlindSpot[]): string {
  const persistent = spots.filter((s) => s.persistent);
  const lines = [
    '# Operator calibration — blind spots (F49)',
    '',
    persistent.length
      ? `${persistent.length} PERSISTENT blind spot(s): corrected in both an older and a recent window — these lessons have not stuck.`
      : 'No persistent blind spots: recurring themes are not repeating across time windows.',
    '',
    '## Themes',
    ...spots
      .slice(0, 10)
      .map((s) => `- **${s.theme}** — ${s.total}× (recent ${s.recent}, older ${s.older})${s.persistent ? ' · **persistent**' : ''}`),
  ];
  return lines.join('\n');
}
