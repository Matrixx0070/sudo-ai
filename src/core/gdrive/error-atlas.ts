/**
 * @file gdrive/error-atlas.ts
 * @description F69 — characteristic-error atlas. Clusters the principal's
 * corrections (the F26 `corrections` dataset, now marker-tagged by F46) into
 * recurring themes, so the agent can be reminded of its characteristic mistakes
 * as a BIAS-PRIORS planning preamble (injected into the live GoalPlanner via the
 * same seam pattern as G-PLANNER's dead-end warning) and broadcast the atlas as
 * a zone-2 self-knowledge shape.
 *
 * Pure/local: reads the on-disk dataset (no Drive I/O in the build), with a
 * short TTL memo so the planner can call the preamble every turn cheaply — the
 * same hot-path-safe contract as matchDeadEnds().
 */

import { readDataset } from './datasets.js';

export interface AtlasCategory {
  /** The recurring theme term. */
  key: string;
  /** How many distinct corrections touch this theme. */
  count: number;
  /** Fraction of those that were explicit directives (never/always/avoid…). */
  directiveShare: number;
  /** Up to two short example corrections. */
  examples: string[];
  /** Distinct F-markers seen in this theme. */
  markers: string[];
}

export interface ErrorAtlas {
  total: number;
  categories: AtlasCategory[];
}

interface CorrectionRow {
  doc?: string;
  correction?: string;
  directive?: boolean;
  marker?: string | null;
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was',
  'were', 'be', 'by', 'with', 'that', 'this', 'it', 'as', 'at', 'from', 'you', 'your',
  'not', 'dont', 'don', 'always', 'never', 'stop', 'prefer', 'use', 'avoid', 'do',
  'when', 'should', 'must', 'can', 'will', 'they', 'them', 'his', 'her', 'its',
]);

export function contentWords(s: string): string[] {
  // Cap length: real error themes are natural words. Long high-entropy tokens
  // are identifiers/keys/hashes, never themes — excluding them also keeps a
  // secret fragment from ever surfacing as a theme key (defence-in-depth on top
  // of the zone screen, which anchors on the original case).
  return (s.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter(
    (w) => !STOP.has(w) && w.length <= 18,
  );
}

/**
 * Build the atlas: top recurring themes across corrections, ranked by how many
 * distinct corrections mention each. A correction contributes once per term
 * (document-frequency), so a single verbose note can't inflate a theme.
 */
export function buildErrorAtlas(opts: { topK?: number; minCount?: number } = {}): ErrorAtlas {
  const topK = opts.topK ?? 6;
  const minCount = opts.minCount ?? 2;
  const rows = readDataset<CorrectionRow>('corrections').filter((r) => typeof r.correction === 'string');

  // term -> aggregation across the corrections that mention it.
  const agg = new Map<string, { count: number; directives: number; examples: string[]; markers: Set<string> }>();
  for (const row of rows) {
    const text = row.correction ?? '';
    const terms = new Set(contentWords(text));
    for (const term of terms) {
      let a = agg.get(term);
      if (!a) {
        a = { count: 0, directives: 0, examples: [], markers: new Set() };
        agg.set(term, a);
      }
      a.count++;
      if (row.directive) a.directives++;
      if (a.examples.length < 2) a.examples.push(text.replace(/\s+/g, ' ').trim().slice(0, 160));
      if (row.marker) a.markers.add(row.marker);
    }
  }

  const categories: AtlasCategory[] = [...agg.entries()]
    .filter(([, a]) => a.count >= minCount)
    .sort((x, y) => y[1].count - x[1].count || x[0].localeCompare(y[0]))
    .slice(0, topK)
    .map(([key, a]) => ({
      key,
      count: a.count,
      directiveShare: a.count ? a.directives / a.count : 0,
      examples: a.examples,
      markers: [...a.markers].sort(),
    }));

  return { total: rows.length, categories };
}

// TTL memo so the hot-path preamble call is cheap.
let memo: { atlas: ErrorAtlas; at: number } | null = null;
const TTL_MS = 5 * 60_000;

/** Cached atlas (rebuilds at most every 5 min). `now` injectable for tests. */
export function getErrorAtlas(now: () => number = () => Date.now()): ErrorAtlas {
  const t = now();
  if (memo && t - memo.at < TTL_MS) return memo.atlas;
  const atlas = buildErrorAtlas();
  memo = { atlas, at: t };
  return atlas;
}

/** Test hook. */
export function _resetAtlasMemo(): void {
  memo = null;
}

/**
 * Short bias-priors preamble for the planner — top 3 themes, one line each.
 * Empty string when there's not enough signal (planner appends nothing).
 */
export function atlasPreamble(now?: () => number): string {
  const atlas = getErrorAtlas(now);
  const top = atlas.categories.slice(0, 3);
  if (top.length === 0) return '';
  const lines = [
    '',
    '## ⚠ CHARACTERISTIC-ERROR PRIORS (from the principal\'s past corrections)',
    'You have been corrected repeatedly on these themes — weight them while planning:',
    ...top.map(
      (c) =>
        `- **${c.key}** (${c.count}×${c.directiveShare >= 0.5 ? ', mostly directives' : ''}${c.markers.length ? `, ${c.markers.join('/')}` : ''}): e.g. "${c.examples[0] ?? ''}"`,
    ),
  ];
  return lines.join('\n');
}

/** Full atlas report (for the zone-2 self-knowledge shape). */
export function renderAtlasReport(atlas: ErrorAtlas): string {
  const lines = [
    '# Characteristic-error atlas (F69)',
    '',
    `Derived from ${atlas.total} principal correction(s).`,
    '',
  ];
  if (atlas.categories.length === 0) {
    lines.push('_Not enough corrections yet to cluster recurring themes._');
    return lines.join('\n');
  }
  for (const c of atlas.categories) {
    lines.push(
      `## ${c.key} — ${c.count}×`,
      `- directive share: ${(c.directiveShare * 100).toFixed(0)}%${c.markers.length ? ` · sources: ${c.markers.join(', ')}` : ''}`,
      ...c.examples.map((e) => `- e.g. "${e}"`),
      '',
    );
  }
  return lines.join('\n');
}
