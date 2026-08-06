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

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Count price-table rows per file, relative to the repo root. */
export function countPriceRows(root: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of walk(join(root, 'src'))) {
    const rel = file.slice(root.length + 1);
    let n = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (PRICE_ROW.test(line)) n += 1;
    }
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

describe('price-table ratchet — the catalog is the single source', () => {
  const counts = countPriceRows(process.cwd());

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
