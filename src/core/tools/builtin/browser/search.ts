/**
 * browser.search — Web search with multiple backends.
 *
 * Backend priority:
 *   1. Brave Search API    — if BRAVE_SEARCH_API_KEY env var is set (fast, 2K free/month)
 *   2. Playwright/Chromium — real browser, bypasses all bot detection (slower ~5s)
 *   3. DuckDuckGo HTML     — last resort, may fail on datacenter IPs
 *
 * Returns formatted results: title, URL, snippet for each hit.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { execSync } from 'node:child_process';

const logger = createLogger('browser.search');

const DEFAULT_MAX_RESULTS = 5;
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ---------------------------------------------------------------------------
// Backend 1: Brave Search API
// ---------------------------------------------------------------------------

async function searchViaBrave(query: string, maxResults: number): Promise<SearchResult[]> {
  const key = process.env['BRAVE_SEARCH_API_KEY'];
  if (!key) throw new Error('BRAVE_SEARCH_API_KEY not set');

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}&text_decorations=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key,
      },
    });
    if (!res.ok) throw new Error(`Brave API returned ${res.status}`);
    const json = await res.json() as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
    const results = json.web?.results ?? [];
    return results.slice(0, maxResults).map(r => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
    }));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Backend 2: Playwright/Chromium via Bing (real browser — bypasses bot detection)
// ---------------------------------------------------------------------------

function decodeBingRedirect(url: string): string {
  // Bing redirect URLs encode the real URL in the `u=a1<base64>` param
  try {
    const m = /[?&]u=a1([^&]+)/.exec(url);
    if (m?.[1]) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      if (decoded.startsWith('http')) return decoded;
    }
    if (url.startsWith('http') && !url.includes('bing.com/ck/')) return url;
  } catch { /* ignore */ }
  return url;
}

/**
 * Build the Playwright script string for a Bing search.
 * Exported for unit testing — inspects that env-var reads are inside the script.
 */
export function _buildSearchScript(query: string, maxResults: number): string {
  return `
const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  const _waitUntil = process.env['SUDO_SEARCH_WAIT_UNTIL'] || 'domcontentloaded';
  const _timeout = parseInt(process.env['SUDO_SEARCH_TIMEOUT_MS'] || '8000', 10);
  await page.goto('https://www.bing.com/search?q=' + encodeURIComponent(${JSON.stringify(query)}), { waitUntil: _waitUntil, timeout: _timeout });
  await new Promise(r => setTimeout(r, 1000));
  const results = await page.evaluate((max) => {
    const items = [];
    const resultEls = document.querySelectorAll('li.b_algo');
    for (const el of Array.from(resultEls).slice(0, max)) {
      const link = el.querySelector('h2 a');
      const snippet = el.querySelector('.b_caption p, .b_algoSlug, p');
      if (link && link.textContent) {
        items.push({
          title: link.textContent.trim(),
          url: link.href || '',
          snippet: snippet ? snippet.textContent.trim().slice(0, 200) : '',
        });
      }
    }
    return items;
  }, ${maxResults});
  await browser.close();
  console.log(JSON.stringify(results));
})().catch(e => { console.error('ERR:' + e.message); process.exit(1); });
`;
}

async function searchViaPlaywright(query: string, maxResults: number): Promise<SearchResult[]> {
  const script = _buildSearchScript(query, maxResults);

  const output = execSync(`node --input-type=commonjs`, {
    input: script,
    encoding: 'utf8',
    timeout: 35_000,
    env: { ...process.env },
  }).trim();

  const parsed = JSON.parse(output) as Array<{ title: string; url: string; snippet: string }>;
  // Decode Bing redirect URLs to real URLs
  return parsed.map(r => ({ ...r, url: decodeBingRedirect(r.url) }));
}

// ---------------------------------------------------------------------------
// Backend 3: DuckDuckGo HTML (fallback)
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function decodeDdgUrl(raw: string): string {
  try {
    const m = /[?&]uddg=([^&]+)/.exec(raw);
    if (m?.[1]) return decodeURIComponent(m[1]);
    if (raw.startsWith('http')) return raw;
  } catch { /* ignore */ }
  return raw;
}

async function searchViaDdgHtml(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}&kl=us-en`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let html: string;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  if (html.includes('anomaly-modal') || html.includes('challenge-form')) {
    throw new Error('DuckDuckGo bot detection triggered');
  }

  const titlePat = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPat = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const titles: Array<{ raw: string; title: string }> = [];
  const snippets: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = titlePat.exec(html)) !== null && titles.length < maxResults) {
    titles.push({ raw: m[1] ?? '', title: stripTags(m[2] ?? '').trim() });
  }
  while ((m = snippetPat.exec(html)) !== null && snippets.length < maxResults) {
    snippets.push(stripTags(m[1] ?? '').trim());
  }

  const results: SearchResult[] = [];
  for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
    const entry = titles[i];
    if (!entry) continue;
    const url = decodeDdgUrl(entry.raw);
    if (url) results.push({ title: entry.title || url, url, snippet: snippets[i] ?? '' });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) return `No results found for "${query}".`;
  return `Search results for "${query}":\n\n` + results
    .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const searchTool: ToolDefinition = {
  name: 'browser.search',
  description:
    'Search the web and return results with titles, URLs, and snippets. ' +
    'Uses Brave API (if BRAVE_SEARCH_API_KEY set) → Playwright/Chromium → DuckDuckGo HTML. ' +
    'Works reliably even from server IPs.',
  category: 'browser',
  timeout: 35_000,
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'Search query string.',
    },
    maxResults: {
      type: 'number',
      required: false,
      description: `Maximum results to return (default: ${DEFAULT_MAX_RESULTS}, max: 10).`,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = params['query'];
    if (typeof query !== 'string' || query.trim() === '') {
      return { success: false, output: 'browser.search: "query" parameter is required.', data: {} };
    }

    const maxResults = Math.min(
      typeof params['maxResults'] === 'number' && params['maxResults'] > 0
        ? Math.floor(params['maxResults'])
        : DEFAULT_MAX_RESULTS,
      10,
    );

    logger.info({ session: ctx.sessionId, query, maxResults }, 'Web search requested');

    // Try backends in priority order
    const backends: Array<{ name: string; fn: () => Promise<SearchResult[]> }> = [
      { name: 'Brave API', fn: () => searchViaBrave(query, maxResults) },
      { name: 'Playwright', fn: () => searchViaPlaywright(query, maxResults) },
      { name: 'DuckDuckGo HTML', fn: () => searchViaDdgHtml(query, maxResults) },
    ];

    let lastError = '';
    for (const backend of backends) {
      try {
        logger.info({ backend: backend.name }, 'Trying search backend');
        const results = await backend.fn();
        if (results.length > 0) {
          logger.info({ backend: backend.name, resultCount: results.length }, 'Search succeeded');
          return {
            success: true,
            output: formatResults(results, query),
            data: { backend: backend.name, resultCount: results.length, results },
          };
        }
        lastError = `${backend.name}: returned 0 results`;
      } catch (err) {
        lastError = `${backend.name}: ${err instanceof Error ? err.message : String(err)}`;
        logger.warn({ backend: backend.name, err: lastError }, 'Backend failed, trying next');
      }
    }

    logger.error({ query, lastError }, 'All search backends failed');
    return {
      success: false,
      output: `Web search failed for "${query}". All backends tried. Last error: ${lastError}\n\nTip: Set BRAVE_SEARCH_API_KEY in .env for reliable search (free at brave.com/search/api/).`,
      data: { resultCount: 0, results: [] },
    };
  },
};
