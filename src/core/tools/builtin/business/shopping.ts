/**
 * Upgrade 61: Commerce / Shopping (Bazaar)
 *
 * Product search and price comparison utilities.  searchProducts is a
 * skeleton wired to return an empty list until a web-search integration
 * (e.g. the browser or search tool) populates it.  compareProducts works
 * immediately on any Product array passed to it.
 */

import { createLogger } from '../../../shared/logger.js';

const log = createLogger('tool:shopping');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Product {
  name: string;
  /** Raw price string including currency symbol, e.g. "$29.99" */
  price: string;
  store: string;
  url: string;
  rating?: number;
  deliveryInfo?: string;
}

export interface ShoppingResult {
  query: string;
  products: Product[];
  bestDeal?: Product;
  searchedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a price string to a numeric value for comparison.
 * Returns Infinity when the string cannot be parsed so unreadable prices
 * sort last.
 */
function parsePrice(price: string): number {
  const cleaned = price.replace(/[^0-9.]/g, '');
  const value = parseFloat(cleaned);
  return Number.isFinite(value) ? value : Infinity;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search for products matching query across available stores.
 *
 * Integration point: replace the stub body with calls to the browser/search
 * tool to fetch real prices from e-commerce sites.
 *
 * @param query  Natural-language product search query.
 */
export async function searchProducts(query: string): Promise<ShoppingResult> {
  if (!query?.trim()) {
    throw new Error('Product search query must not be empty');
  }

  const trimmedQuery = query.trim();
  log.info({ query: trimmedQuery }, 'Product search initiated');

  // Stub — real implementation would call web search and parse results
  const products: Product[] = [];

  const result: ShoppingResult = {
    query: trimmedQuery,
    products,
    searchedAt: new Date().toISOString(),
  };

  if (products.length > 0) {
    result.bestDeal = [...products].sort(
      (a, b) => parsePrice(a.price) - parsePrice(b.price),
    )[0];
  }

  log.info({ query: trimmedQuery, found: products.length }, 'Product search complete');
  return result;
}

/**
 * Sort products by price ascending and format a readable comparison table.
 *
 * @param products  Array of Product objects to compare.
 */
export function compareProducts(products: Product[]): string {
  if (!products || products.length === 0) return 'No products to compare.';

  const sorted = [...products].sort(
    (a, b) => parsePrice(a.price) - parsePrice(b.price),
  );

  const lines: string[] = ['**Price Comparison:**'];

  for (const p of sorted) {
    const rating = p.rating != null ? ` (${p.rating.toFixed(1)} stars)` : '';
    lines.push(`- ${p.store}: ${p.price}${rating} — ${p.name}`);
    if (p.deliveryInfo) lines.push(`  ${p.deliveryInfo}`);
    if (p.url) lines.push(`  ${p.url}`);
  }

  const bestPrice = parsePrice(sorted[0].price);
  const worstPrice = parsePrice(sorted[sorted.length - 1].price);
  if (Number.isFinite(bestPrice) && Number.isFinite(worstPrice) && sorted.length > 1) {
    const saving = (worstPrice - bestPrice).toFixed(2);
    lines.push(`\n_Best deal saves you ~$${saving} vs. most expensive option._`);
  }

  log.info({ count: sorted.length }, 'Product comparison formatted');
  return lines.join('\n');
}
