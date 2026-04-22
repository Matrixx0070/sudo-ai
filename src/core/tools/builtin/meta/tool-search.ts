/**
 * @file tool-search.ts
 * @description Meta search tools for discovering MCP catalog entries and npm packages.
 *
 * Tools:
 *   tool.search-mcp-catalog — Search the MCP tool registry for a capability
 *   tool.search-npm          — Search the npm registry for a package
 *
 * Both tools use global fetch with a 10-second AbortController timeout and
 * return { success, output } per ToolResult contract.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta:tool-search');

const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Perform a GET request with an AbortController timeout.
 * Returns the parsed JSON body or throws on network/timeout/parse error.
 */
async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.json() as unknown;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// tool.search-mcp-catalog
// ---------------------------------------------------------------------------

export const searchMcpCatalogTool: ToolDefinition = {
  name: 'tool.search-mcp-catalog',
  category: 'meta',
  description:
    'Search the MCP tool catalog for a tool or capability. Returns the top 5 matching MCP server names and descriptions.',
  timeout: 15_000,
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'Tool name or capability to search for.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = params['query'] as string | undefined;
    logger.info({ session: ctx.sessionId, query }, 'tool.search-mcp-catalog invoked');

    if (!query?.trim()) {
      return { success: false, output: 'query is required.' };
    }

    const encodedQuery = encodeURIComponent(query.trim().slice(0, 200));
    const url = `https://registry.modelcontextprotocol.io/api/search?q=${encodedQuery}`;

    try {
      const data = await fetchJson(url);
      const results = extractMcpResults(data);

      if (results.length === 0) {
        return { success: true, output: `No MCP catalog entries found for: "${query}"`, data: [] };
      }

      const lines = results.map((r, i) => `${i + 1}. ${r.name} — ${r.description}`);
      const output = `MCP catalog results for "${query}":\n${lines.join('\n')}`;
      return { success: true, output, data: results };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ query, err: msg }, 'tool.search-mcp-catalog fetch error');
      return { success: false, output: `MCP catalog search failed: ${msg}` };
    }
  },
};

interface McpResult {
  name: string;
  description: string;
}

function extractMcpResults(data: unknown): McpResult[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;

  // The registry API returns { servers: [...] } or { results: [...] } or just an array
  const rawItems: unknown[] = Array.isArray(d['servers'])
    ? (d['servers'] as unknown[])
    : Array.isArray(d['results'])
    ? (d['results'] as unknown[])
    : Array.isArray(data)
    ? (data as unknown[])
    : [];

  return rawItems
    .slice(0, 5)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const r = item as Record<string, unknown>;
      const name = typeof r['name'] === 'string' ? r['name'] : '(unnamed)';
      const description = typeof r['description'] === 'string'
        ? r['description'].slice(0, 200)
        : '(no description)';
      return { name, description };
    })
    .filter((r): r is McpResult => r !== null);
}

// ---------------------------------------------------------------------------
// tool.search-npm
// ---------------------------------------------------------------------------

export const searchNpmTool: ToolDefinition = {
  name: 'tool.search-npm',
  category: 'meta',
  description:
    'Search the npm registry for a package that might provide a missing tool. Returns the top 5 matching package names and descriptions.',
  timeout: 15_000,
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'Package name or keyword to search for.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = params['query'] as string | undefined;
    logger.info({ session: ctx.sessionId, query }, 'tool.search-npm invoked');

    if (!query?.trim()) {
      return { success: false, output: 'query is required.' };
    }

    const encodedQuery = encodeURIComponent(query.trim().slice(0, 200));
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodedQuery}&size=5`;

    try {
      const data = await fetchJson(url);
      const results = extractNpmResults(data);

      if (results.length === 0) {
        return { success: true, output: `No npm packages found for: "${query}"`, data: [] };
      }

      const lines = results.map((r, i) => `${i + 1}. ${r.name} — ${r.description}`);
      const output = `npm packages for "${query}":\n${lines.join('\n')}`;
      return { success: true, output, data: results };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ query, err: msg }, 'tool.search-npm fetch error');
      return { success: false, output: `npm search failed: ${msg}` };
    }
  },
};

interface NpmResult {
  name: string;
  description: string;
}

function extractNpmResults(data: unknown): NpmResult[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  const objects = d['objects'];
  if (!Array.isArray(objects)) return [];

  return (objects as unknown[])
    .slice(0, 5)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const r = item as Record<string, unknown>;
      const pkg = r['package'];
      if (!pkg || typeof pkg !== 'object') return null;
      const p = pkg as Record<string, unknown>;
      const name = typeof p['name'] === 'string' ? p['name'] : '(unnamed)';
      const description = typeof p['description'] === 'string'
        ? p['description'].slice(0, 200)
        : '(no description)';
      return { name, description };
    })
    .filter((r): r is NpmResult => r !== null);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSearchTools(registry: import('../../registry.js').ToolRegistry): void {
  registry.register(searchMcpCatalogTool);
  registry.register(searchNpmTool);
}
