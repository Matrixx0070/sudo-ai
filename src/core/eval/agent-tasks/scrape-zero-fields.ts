/**
 * @file scrape-zero-fields.ts
 * @description Extraction task distilled from the 2026-07-24 browser-extractor
 * incident: a scrape "succeeded" with ZERO extracted fields and the empty
 * result flowed downstream as success. The agent must extract structured
 * fields from a local HTML file; the verifier fails on an empty result set or
 * any empty/missing field — an all-empty extraction can never pass.
 *
 * Exercises: extraction completeness + refusing to treat 0 fields as success.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentBenchTask } from '../agent-bench-types.js';

// Attribute quoting varies and one card carries a decoy class — a selector
// typo'd against the decoy yields zero matches, reproducing the incident shape.
const PAGE_HTML = `<!doctype html>
<html><body>
  <div class="product-card decoy-banner">SALE SALE SALE</div>
  <div class="product-card" data-sku="A-100">
    <h2 class="title">Aurora Lamp</h2><span class='price'>$49.99</span>
  </div>
  <div class="product-card" data-sku="B-200">
    <h2 class="title">Basalt Mug</h2><span class="price">$12.50</span>
  </div>
  <div class="product-card" data-sku="C-300">
    <h2 class="title">Cedar Shelf</h2><span class='price'>$89.00</span>
  </div>
</body></html>
`;

const EXPECTED: Array<{ title: string; price: string }> = [
  { title: 'Aurora Lamp', price: '$49.99' },
  { title: 'Basalt Mug', price: '$12.50' },
  { title: 'Cedar Shelf', price: '$89.00' },
];

export const scrapeZeroFieldsTask: AgentBenchTask = {
  id: 'scrape-zero-fields',
  name: 'Extraction: three product cards, zero-field results are failures',
  async setupWorkspace(workspaceDir: string): Promise<void> {
    await fs.writeFile(path.join(workspaceDir, 'page.html'), PAGE_HTML, 'utf8');
  },
  prompt: [
    'In {workspace}: read page.html and extract every real product card',
    '(ignore the decoy banner). Write out.json as a JSON array of',
    '{"title", "price"} objects in page order. Every object must have both',
    'fields non-empty — an empty extraction is a failure, not a success.',
  ].join(' '),
  async verifyWorkspace(workspaceDir: string) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(workspaceDir, 'out.json'), 'utf8');
    } catch {
      return { passed: false, score: 0, detail: 'out.json missing', type: 'workspace-files' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { passed: false, score: 0, detail: `out.json is not valid JSON: ${String(err)}`, type: 'workspace-files' };
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      // The incident class itself: empty result presented as output.
      return { passed: false, score: 0, detail: 'zero extracted records — the 0-fields incident class', type: 'workspace-files' };
    }
    const rows = parsed as Array<Record<string, unknown>>;
    for (const [i, row] of rows.entries()) {
      const title = typeof row['title'] === 'string' ? row['title'].trim() : '';
      const price = typeof row['price'] === 'string' ? row['price'].trim() : '';
      if (!title || !price) {
        return { passed: false, score: 0, detail: `record ${i} has an empty field — 0-field extraction must fail`, type: 'workspace-files' };
      }
    }
    const got = rows.map((r) => ({ title: String(r['title']).trim(), price: String(r['price']).trim() }));
    const matches = EXPECTED.filter(
      (e, i) => got[i] && got[i]!.title === e.title && got[i]!.price === e.price,
    ).length;
    const score = matches / EXPECTED.length;
    return {
      passed: matches === EXPECTED.length && got.length === EXPECTED.length,
      score,
      detail: matches === EXPECTED.length && got.length === EXPECTED.length
        ? 'all 3 records extracted correctly'
        : `${matches}/${EXPECTED.length} records correct (got ${got.length} records)`,
      type: 'workspace-files',
    };
  },
};
