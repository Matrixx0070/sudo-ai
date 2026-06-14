/**
 * @file search-tools.ts
 * @description `meta.search-tools` (gap #22) — keyword search over the
 * LOCAL ToolRegistry so the agent can discover tools without all 200+
 * full schemas being loaded into the model's context at boot.
 *
 * Distinct from the pre-existing `tool.search-mcp-catalog` / `tool.
 * search-npm` (which hit external registries). This one is purely
 * in-process: case-insensitive substring match against name, category,
 * and description, ranked by match-quality + tie-broken by name length.
 *
 * Why a tool, not a registry method: the calling agent already has
 * `system.exec`, `coder.*`, `web.*` etc. in its prompt. When it needs
 * something obscure (e.g. "find a tool to convert PDF to text") it
 * issues a `meta.search-tools` call and receives a list of names +
 * descriptions + brief parameter signature — small payload, no
 * full-schema injection unless the agent then invokes the matched tool
 * by name.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import type { ToolRegistry } from '../../registry.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta.search-tools');

// ---------------------------------------------------------------------------
// Dependency injection — the live ToolRegistry the search runs against.
// Set via setSearchToolsRegistry() during boot, mirroring the meta.ptc
// pattern. A standalone setter is the right shape because only this
// tool needs the registry and bundling it into injectMetaToolDeps would
// touch every meta tool's signature for a single consumer.
// ---------------------------------------------------------------------------

let _registry: ToolRegistry | null = null;

export function setSearchToolsRegistry(registry: ToolRegistry | null): void {
  _registry = registry;
}

// ---------------------------------------------------------------------------
// Pure scoring + ranking
// ---------------------------------------------------------------------------

interface SearchHit {
  name: string;
  category: string;
  description: string;
  paramSummary: string;
  /** Internal ranking score; not surfaced to the model. */
  score: number;
}

/**
 * Rank a single tool against the query. Higher scores beat lower scores
 * in the result list. Match heuristics (in order of weight):
 *   - exact-name match → 100
 *   - name startsWith query → 50
 *   - name contains query → 25
 *   - category exact → 30
 *   - category contains → 10
 *   - description contains → 5
 * Each is cumulative — a tool that matches name AND category beats one
 * that matches name only.
 */
function scoreTool(tool: ToolDefinition, queryLower: string): number {
  if (!queryLower) return 0;
  const name = tool.name.toLowerCase();
  const category = (tool.category ?? '').toLowerCase();
  const description = (tool.description ?? '').toLowerCase();

  let score = 0;
  if (name === queryLower) score += 100;
  else if (name.startsWith(queryLower)) score += 50;
  else if (name.includes(queryLower)) score += 25;

  if (category === queryLower) score += 30;
  else if (category && category.includes(queryLower)) score += 10;

  if (description.includes(queryLower)) score += 5;
  return score;
}

/** Compact parameter signature: `(param1: type, param2?: type, ...)`. */
function paramSummary(tool: ToolDefinition): string {
  const params = tool.parameters as Record<string, { type?: string; required?: boolean }> | undefined;
  if (!params || typeof params !== 'object') return '()';
  const entries = Object.entries(params);
  if (entries.length === 0) return '()';
  const sig = entries.map(([name, def]) => {
    const ty = def?.type ?? 'any';
    const opt = def?.required === false || def?.required === undefined ? '?' : '';
    return `${name}${opt}: ${ty}`;
  });
  return `(${sig.join(', ')})`;
}

/**
 * Run the search. Pure function — takes the registry and query, returns
 * the ranked hits. Limits and includeDisabled are caller-controlled.
 */
export function searchTools(
  registry: ToolRegistry,
  query: string,
  options: { limit?: number; includeDisabled?: boolean; category?: string } = {},
): SearchHit[] {
  const queryLower = (query ?? '').trim().toLowerCase();
  const limit = options.limit ?? 10;
  const all = options.includeDisabled ? registry.listAll() : registry.listEnabled();
  const scored: SearchHit[] = [];
  for (const tool of all) {
    if (options.category && tool.category !== options.category) continue;
    const score = queryLower ? scoreTool(tool, queryLower) : 1;
    if (score <= 0) continue;
    scored.push({
      name: tool.name,
      category: tool.category ?? 'uncategorised',
      description: (tool.description ?? '').slice(0, 240),
      paramSummary: paramSummary(tool),
      score,
    });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.length - b.name.length;
  });
  return scored.slice(0, Math.min(Math.max(limit, 1), 50));
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const searchToolsTool: ToolDefinition = {
  name: 'meta.search-tools',
  description:
    'Search the local ToolRegistry by keyword. Returns matching tool names + ' +
    'category + 240-char description + compact parameter signature, ranked by ' +
    'match quality. Use when you need a tool you don\'t see by name — the full ' +
    'schema is NOT injected here; once you find a match, call it by name. ' +
    'Supports an optional `category` filter and a `limit` (default 10, max 50).',
  category: 'meta' as const,
  safety: 'readonly',
  requiresConfirmation: false,
  timeout: 1_000,
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: 'Keyword to search for in tool name, category, and description.',
    },
    limit: {
      type: 'number',
      description: 'Max results to return (default 10, max 50).',
      default: 10,
    },
    category: {
      type: 'string',
      description: 'Optional category filter (e.g. "coder", "system", "meta").',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const registry = _registry;
    if (!registry) {
      return {
        success: false,
        output:
          'meta.search-tools: registry has not been injected. ' +
          'Call setSearchToolsRegistry() during boot (cli.ts wires this).',
      };
    }
    const query = typeof params['query'] === 'string' ? (params['query'] as string).trim() : '';
    const category = typeof params['category'] === 'string' && (params['category'] as string).length > 0
      ? (params['category'] as string)
      : undefined;
    // Browse mode: empty query is allowed when a category is supplied
    // (verifier HIGH #2 — previously the pure function allowed browse
    // mode but execute() refused it, leaving the agent no way through).
    if (!query && !category) {
      return {
        success: false,
        output:
          'meta.search-tools: provide a `query` keyword OR a `category` filter ' +
          '(empty query enumerates that category — browse mode).',
      };
    }
    const rawLimit = params['limit'];
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : 10;

    logger.info({ sessionId: ctx.sessionId, query, limit, category }, 'searching tools');
    const hits = searchTools(registry, query, { limit, ...(category !== undefined ? { category } : {}) });

    if (hits.length === 0) {
      return {
        success: true,
        output: `No tools matched "${query}"${category ? ` (category=${category})` : ''}.`,
        data: [],
      };
    }

    const lines = hits.map((h, i) => `${i + 1}. ${h.name} ${h.paramSummary} [${h.category}] — ${h.description}`);
    return {
      success: true,
      output: `Found ${hits.length} matching tool(s) for "${query}":\n${lines.join('\n')}`,
      data: hits.map(({ name, category, description, paramSummary: sig }) => ({ name, category, description, paramSummary: sig })),
    };
  },
};
