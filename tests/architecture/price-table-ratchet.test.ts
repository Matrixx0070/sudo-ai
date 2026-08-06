/**
 * @file tests/architecture/price-table-ratchet.test.ts
 * @description ADR 0010 D2 — keep the model catalog the SINGLE source of price.
 *
 * Model facts once lived in six places with different fallbacks, so a model
 * missing from one table fell through to $3/$15 in one path and $5/$20 in
 * another — silently, and each consumer disagreed. That produced real money
 * bugs: the judge billed 5x from a dated-vs-bare key mismatch, `ollama/*`
 * priced at $5/$20 (the ~$473 phantom-spend pattern), and a $0 mission parked
 * at "$8.80 of $5.00".
 *
 * `src/llm/model-catalog.ts` is now that single source. This ratchet stops a
 * SEVENTH table appearing: a price row keyed by a model id may only exist in
 * the catalog. The one remaining legacy table is pinned at its current size, so
 * it can shrink to zero but never grow.
 *
 * This is deliberately a ratchet, not a ban — deleting the last legacy table is
 * a separate decision (it is still re-exported, though nothing imports it).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A `'provider/model': { …PerM… }` price row — i.e. a price TABLE entry. */
const PRICE_ROW = /['"][\w.-]+\/[\w.:-]+['"]\s*:\s*\{[^}]*(?:inUsdPerM|inputPerM|outUsdPerM|outputPerM)/;

/**
 * A `'provider/model': { context_window… }` LIMIT row. Same drift risk as
 * price: a model missing from the limits table silently gets the 128K default,
 * so a 1M-context model is compacted at 128K and a long generation truncated.
 */
const LIMIT_ROW = /['"][\w.-]+\/[\w.:-]+['"]\s*:\s*\{[^}]*(?:context_window|contextWindow|max_output)/;

/**
 * Files allowed to contain price rows.
 *   - model-catalog.ts is the single source (it builds rows via a helper, so it
 *     does not even match the pattern — listed for intent).
 *   - costs.ts COST_RATES is SUPERSEDED: estimateCost() delegates to the
 *     catalog, nothing reads the table. Pinned so it can only shrink.
 */
const ALLOWED: Record<string, number> = {
  'src/llm/model-catalog.ts': Number.POSITIVE_INFINITY,
  'src/core/brain/costs.ts': 35,
};

/**
 * Files allowed to contain LIMIT rows. Unlike PRICE_TABLE (deleted, #1086),
 * limits.ts MODEL_LIMITS is still load-bearing — only pricing was delegated so
 * far — so it is pinned rather than banned: new models go in the catalog.
 */
const ALLOWED_LIMITS: Record<string, number> = {
  'src/llm/model-catalog.ts': Number.POSITIVE_INFINITY,
  'src/llm/limits.ts': 26,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Count rows matching `pattern` per file, relative to the repo root. */
export function countRows(root: string, pattern: RegExp): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of walk(join(root, 'src'))) {
    const rel = file.slice(root.length + 1);
    let n = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (pattern.test(line)) n += 1;
    }
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

/** Back-compat helper: price rows only. */
export function countPriceRows(root: string): Map<string, number> {
  return countRows(root, PRICE_ROW);
}

describe('price-table ratchet — the catalog is the single source', () => {
  const counts = countRows(process.cwd(), PRICE_ROW);

  it('no NEW file declares model prices', () => {
    const unexpected = [...counts.keys()].filter((f) => !(f in ALLOWED));
    expect(
      unexpected,
      `These files declare model price rows. Add the model to ` +
      `src/llm/model-catalog.ts instead — a second table is how six tables ` +
      `came to disagree and bill the judge 5x.`,
    ).toEqual([]);
  });

  it('the superseded legacy table can shrink but never grow', () => {
    for (const [file, cap] of Object.entries(ALLOWED)) {
      if (!Number.isFinite(cap)) continue;
      const actual = counts.get(file) ?? 0;
      expect(
        actual,
        `${file} gained price rows (${actual} > ${cap}). It is SUPERSEDED — ` +
        `estimateCost() delegates to model-catalog.ts and nothing reads this ` +
        `table. New models go in the catalog; lower this cap when rows are removed.`,
      ).toBeLessThanOrEqual(cap);
    }
  });

  it('the detector actually catches a planted price row', () => {
    // Guard against the check silently matching nothing.
    expect(PRICE_ROW.test(`  'anthropic/claude-opus-5': { inputPerM: 5.0, outputPerM: 25.0 },`)).toBe(true);
    expect(PRICE_ROW.test(`  'xai/grok-3': { inUsdPerM: 0.3, outUsdPerM: 0.5 },`)).toBe(true);
    // …and does not fire on ordinary code.
    expect(PRICE_ROW.test(`  const rate = rateFor(model);`)).toBe(false);
  });
});

describe('seat-list ratchet — the pair whose disagreement caused two outages', () => {
  /** A literal list of seat/subscription lane prefixes. */
  const SEAT_LIST = /\[\s*['"]claude-oauth\//;

  it('the seat lane list is declared in exactly ONE file', () => {
    const files = [...countRows(process.cwd(), SEAT_LIST).keys()];
    expect(
      files,
      `The seat list must exist once (model-catalog.ts SEAT_LANE_PREFIXES). Two ` +
      `copies drifting is what priced flat-subscription calls as dollars twice: ` +
      `418 calls booked as "$51" blew a $50 cap, and ollama :cloud mispricing ` +
      `booked ~$473 of phantom spend and took the product down.`,
    ).toEqual(['src/llm/model-catalog.ts']);
  });

  it('the seat detector catches a planted second list', () => {
    expect(SEAT_LIST.test(`const SEAT = ['claude-oauth/', 'ollama/'] as const;`)).toBe(true);
    expect(SEAT_LIST.test(`  if (isSeatLane(model)) return 0;`)).toBe(false);
  });
});

describe('limit-table ratchet — context windows have one source too', () => {
  const counts = countRows(process.cwd(), LIMIT_ROW);

  it('no NEW file declares model context limits', () => {
    const unexpected = [...counts.keys()].filter((f) => !(f in ALLOWED_LIMITS));
    expect(
      unexpected,
      `These files declare model limit rows. Add the model to ` +
      `src/llm/model-catalog.ts instead — a model missing from a limits table ` +
      `silently gets the 128K default, so a 1M-context model is compacted at 128K.`,
    ).toEqual([]);
  });

  it('the legacy limits table can shrink but never grow', () => {
    for (const [file, cap] of Object.entries(ALLOWED_LIMITS)) {
      if (!Number.isFinite(cap)) continue;
      const actual = counts.get(file) ?? 0;
      expect(
        actual,
        `${file} gained limit rows (${actual} > ${cap}). New models go in ` +
        `model-catalog.ts; lower this cap as rows are removed.`,
      ).toBeLessThanOrEqual(cap);
    }
  });

  it('the limit detector actually catches a planted row', () => {
    expect(LIMIT_ROW.test(`  'anthropic/claude-opus-5': { context_window: 1_000_000, max_output: 128_000 },`)).toBe(true);
    expect(LIMIT_ROW.test(`  const { context_window } = limitsFor(model);`)).toBe(false);
  });
});
