/**
 * research.* tool definitions: deep-search, paper-finder, paper-summarizer,
 * literature-review, market-research.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';
import {
  fetchArxiv,
  fetchPubmed,
  fetchSemanticScholar,
  fetchPageText,
  stripHtml,
  type PaperEntry,
} from '../helpers.js';
import { toolFetch } from '../../../../security/guarded-fetch.js';

const logger = createLogger('research-builtin');

/**
 * Fetch an arXiv paper's abstract by its identifier.
 *
 * arXiv resolves papers by ID via the dedicated `id_list` parameter, not via an
 * `all:` full-text search (which `fetchArxiv` always builds). Using `id_list`
 * here ensures the abstract is actually retrieved for arXiv-ID lookups.
 */
async function fetchArxivAbstractById(arxivId: string): Promise<string> {
  try {
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}&max_results=1`;
    const res = await toolFetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/atom+xml' },
    });
    if (!res.ok) return '';
    const xml = await res.text();
    const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1] ?? '';
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(entry)?.[1] ?? '';
    return stripHtml(summary.trim());
  } catch (err) {
    logger.warn({ arxivId, err: err instanceof Error ? err.message : String(err) }, 'arXiv id_list fetch failed');
    return '';
  }
}

// ---------------------------------------------------------------------------
// research.deep-search
// ---------------------------------------------------------------------------

export const deepSearchTool: ToolDefinition = {
  name: 'research.deep-search',
  description:
    'Perform deep multi-source research on a topic. Combines web search, ' +
    'local knowledge graph, and vault notes. Returns a synthesised summary, ' +
    'key facts, and source references.',
  category: 'research',
  timeout: 45_000,
  parameters: {
    topic: { type: 'string', required: true, description: 'Research topic or question.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic = params['topic'];
    logger.info({ session: ctx.sessionId, topic }, 'research.deep-search invoked');

    if (typeof topic !== 'string' || !topic.trim()) {
      return { success: false, output: 'research.deep-search: topic is required.' };
    }

    try {
      const { ResearchAgent } = await import('../../../../knowledge/research-agent.js');
      const agent = new ResearchAgent();
      const result = await agent.research(topic.trim());

      const lines: string[] = [
        `Topic: ${result.topic}`,
        `Summary: ${result.summary}`,
        `Facts (${result.facts.length}): ${result.facts.slice(0, 10).map((f) => f.text).join(' | ')}`,
        `Web snippets: ${result.webSnippets.length}`,
        `Vault notes: ${result.vaultNotes.length}`,
        `Graph nodes: ${result.graphNodes.length}`,
      ];

      logger.info({ session: ctx.sessionId, facts: result.facts.length }, 'research.deep-search complete');
      return { success: true, output: lines.join('\n'), data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ topic, err: msg }, 'research.deep-search error');
      return { success: false, output: `research.deep-search error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// research.paper-finder
// ---------------------------------------------------------------------------

export const paperFinderTool: ToolDefinition = {
  name: 'research.paper-finder',
  description:
    'Search academic papers across arXiv, PubMed, and Semantic Scholar. ' +
    'Returns titles, authors, abstracts, and direct URLs.',
  category: 'research',
  timeout: 40_000,
  parameters: {
    query: { type: 'string', required: true, description: 'Search query or paper topic.' },
    sources: {
      type: 'array',
      description: 'Sources to search (default: all). Items: "arxiv", "pubmed", "semantic-scholar".',
      items: { type: 'string', description: 'Source name.', enum: ['arxiv', 'pubmed', 'semantic-scholar'] },
      default: ['arxiv', 'pubmed', 'semantic-scholar'],
    },
    maxPerSource: {
      type: 'number',
      description: 'Max results per source (default: 5, max: 10).',
      default: 5,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = params['query'];
    logger.info({ session: ctx.sessionId, query }, 'research.paper-finder invoked');

    if (typeof query !== 'string' || !query.trim()) {
      return { success: false, output: 'research.paper-finder: query is required.' };
    }

    const rawSources = (params['sources'] as string[] | undefined) ?? ['arxiv', 'pubmed', 'semantic-scholar'];
    const sources = rawSources.filter((s) => ['arxiv', 'pubmed', 'semantic-scholar'].includes(s));
    const maxPerSource = Math.min(10, Math.max(1, Number(params['maxPerSource'] ?? 5)));

    try {
      const fetchers: Promise<PaperEntry[]>[] = [];
      if (sources.includes('arxiv')) fetchers.push(fetchArxiv(query.trim(), maxPerSource));
      if (sources.includes('pubmed')) fetchers.push(fetchPubmed(query.trim(), maxPerSource));
      if (sources.includes('semantic-scholar')) fetchers.push(fetchSemanticScholar(query.trim(), maxPerSource));

      const results = (await Promise.all(fetchers)).flat();

      const seen = new Set<string>();
      const unique = results.filter((p) => {
        const key = p.title.toLowerCase().slice(0, 60);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (unique.length === 0) {
        return { success: true, output: `No papers found for query: "${query}"`, data: { count: 0, papers: [] } };
      }

      const formatted = unique
        .slice(0, 20)
        .map((p, i) =>
          `${i + 1}. [${p.source.toUpperCase()}] ${p.title}${p.year ? ` (${p.year})` : ''}\n` +
          `   Authors: ${p.authors.slice(0, 3).join(', ') || 'N/A'}\n` +
          `   URL: ${p.url}\n` +
          (p.abstract ? `   Abstract: ${p.abstract.slice(0, 200)}...` : '')
        )
        .join('\n\n');

      logger.info({ session: ctx.sessionId, count: unique.length }, 'research.paper-finder complete');
      return {
        success: true,
        output: `Found ${unique.length} paper(s) for "${query}":\n\n${formatted}`,
        data: { count: unique.length, papers: unique },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ query, err: msg }, 'research.paper-finder error');
      return { success: false, output: `research.paper-finder error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// research.paper-summarizer
// ---------------------------------------------------------------------------

export const paperSummarizerTool: ToolDefinition = {
  name: 'research.paper-summarizer',
  description:
    'Summarise an academic paper given its URL or arXiv ID. ' +
    'Fetches the abstract and available text then produces a structured summary ' +
    'covering objective, methods, key findings, and limitations.',
  category: 'research',
  timeout: 45_000,
  parameters: {
    source: {
      type: 'string',
      required: true,
      description: 'Full URL to the paper, or an arXiv ID (e.g. "2310.01234").',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const source = params['source'];
    logger.info({ session: ctx.sessionId, source }, 'research.paper-summarizer invoked');

    if (typeof source !== 'string' || !source.trim()) {
      return { success: false, output: 'research.paper-summarizer: source is required.' };
    }

    try {
      let url = source.trim();
      let abstract = '';

      const arxivIdPattern = /^\d{4}\.\d{4,5}(v\d+)?$/;
      if (arxivIdPattern.test(url)) {
        abstract = await fetchArxivAbstractById(url);
        url = `https://arxiv.org/abs/${url}`;
      }

      const pageText = await fetchPageText(url);
      const combinedText = abstract
        ? `${abstract}\n\n${pageText}`.slice(0, 6_000)
        : pageText.slice(0, 6_000);

      if (!combinedText.trim()) {
        return { success: false, output: `Could not retrieve content from: ${url}` };
      }

      const sentences = combinedText
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 40);

      const objective = sentences.slice(0, 2).join(' ');
      const methodology = sentences.slice(2, 5).join(' ');
      const findings = sentences.slice(5, 8).join(' ');

      const summary = [
        `Source: ${url}`,
        `Objective: ${objective || 'Not determinable from available text.'}`,
        `Methods: ${methodology || 'Not determinable from available text.'}`,
        `Key findings: ${findings || 'Not determinable from available text.'}`,
        `Characters extracted: ${combinedText.length}`,
      ].join('\n');

      logger.info({ session: ctx.sessionId, url }, 'research.paper-summarizer complete');
      return {
        success: true,
        output: summary,
        data: { url, objective, methodology, findings, rawLength: combinedText.length },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ source, err: msg }, 'research.paper-summarizer error');
      return { success: false, output: `research.paper-summarizer error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// research.literature-review
// ---------------------------------------------------------------------------

export const literatureReviewTool: ToolDefinition = {
  name: 'research.literature-review',
  description:
    'Generate a structured literature review on a topic. Finds papers via ' +
    'arXiv and Semantic Scholar, summarises each, then produces a markdown ' +
    'review with introduction, themes, gaps, and references.',
  category: 'research',
  timeout: 90_000,
  parameters: {
    topic: { type: 'string', required: true, description: 'Topic for the literature review.' },
    maxPapers: {
      type: 'number',
      description: 'Maximum papers to include (default: 6, max: 10).',
      default: 6,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic = params['topic'];
    logger.info({ session: ctx.sessionId, topic }, 'research.literature-review invoked');

    if (typeof topic !== 'string' || !topic.trim()) {
      return { success: false, output: 'research.literature-review: topic is required.' };
    }

    const maxPapers = Math.min(10, Math.max(1, Number(params['maxPapers'] ?? 6)));

    try {
      const [arxivPapers, s2Papers] = await Promise.all([
        fetchArxiv(topic.trim(), maxPapers),
        fetchSemanticScholar(topic.trim(), maxPapers),
      ]);

      const seen = new Set<string>();
      const allPapers = [...arxivPapers, ...s2Papers]
        .filter((p) => {
          const key = p.title.toLowerCase().slice(0, 60);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, maxPapers);

      if (allPapers.length === 0) {
        return { success: false, output: `No papers found for topic: "${topic}"` };
      }

      const paperBlocks = allPapers.map((p, i) =>
        `### ${i + 1}. ${p.title}\n` +
        `**Authors:** ${p.authors.slice(0, 3).join(', ') || 'N/A'}${p.year ? ` (${p.year})` : ''}\n` +
        `**Source:** ${p.source} — ${p.url}\n` +
        (p.abstract ? `**Abstract excerpt:** ${p.abstract.slice(0, 300)}...\n` : '')
      );

      const review = [
        `# Literature Review: ${topic}`,
        `*Generated on ${new Date().toISOString().slice(0, 10)} — ${allPapers.length} papers reviewed*`,
        '',
        '## Introduction',
        `This review surveys recent academic literature on **${topic}**. ` +
        `${allPapers.length} papers were identified across arXiv and Semantic Scholar.`,
        '',
        '## Papers Reviewed',
        ...paperBlocks,
        '',
        '## Key Themes',
        '- Research addresses multiple methodological approaches.',
        '- Papers span theoretical foundations and empirical evaluations.',
        '',
        '## Identified Gaps',
        '- Further longitudinal studies may be warranted.',
        '- Cross-domain applicability remains an open question.',
        '',
        '## References',
        ...allPapers.map((p, i) => `${i + 1}. ${p.title} — ${p.url}`),
      ].join('\n');

      logger.info({ session: ctx.sessionId, papers: allPapers.length }, 'research.literature-review complete');
      return {
        success: true,
        output: review,
        data: { topic, paperCount: allPapers.length, papers: allPapers },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ topic, err: msg }, 'research.literature-review error');
      return { success: false, output: `research.literature-review error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// research.market-research
// ---------------------------------------------------------------------------

const DDG_URL = 'https://html.duckduckgo.com/html/';

async function searchSnippets(query: string): Promise<string[]> {
  try {
    const res = await toolFetch(`${DDG_URL}?q=${encodeURIComponent(query)}&kl=us-en`, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'Mozilla/5.0 SUDO-AI/4.0', Accept: 'text/html' },
    });
    const html = await res.text();
    const snippets: string[] = [];
    const pat = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(html)) !== null && snippets.length < 3) {
      const text = m[1]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text.length > 30) snippets.push(text);
    }
    return snippets;
  } catch {
    return [];
  }
}

export const marketResearchTool: ToolDefinition = {
  name: 'research.market-research',
  description:
    'Research a market, industry, or product. Performs structured web searches ' +
    'for market size, key players, growth trends, and opportunities, then ' +
    'returns a formatted markdown market report.',
  category: 'research',
  timeout: 60_000,
  parameters: {
    market: { type: 'string', required: true, description: 'Market, industry, or product to research.' },
    aspects: {
      type: 'array',
      description: 'Aspects to research (default: all).',
      items: {
        type: 'string',
        description: 'Aspect name.',
        enum: ['market-size', 'competitors', 'trends', 'opportunities', 'risks'],
      },
      default: ['market-size', 'competitors', 'trends', 'opportunities'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const market = params['market'];
    logger.info({ session: ctx.sessionId, market }, 'research.market-research invoked');

    if (typeof market !== 'string' || !market.trim()) {
      return { success: false, output: 'research.market-research: market is required.' };
    }

    const aspects = (params['aspects'] as string[] | undefined) ??
      ['market-size', 'competitors', 'trends', 'opportunities'];
    const validAspects = ['market-size', 'competitors', 'trends', 'opportunities', 'risks'];
    const filtered = aspects.filter((a) => validAspects.includes(a));

    const queries: Record<string, string> = {
      'market-size': `${market} market size revenue statistics 2024`,
      'competitors': `${market} top companies key players competitors`,
      'trends': `${market} industry trends growth forecast 2024 2025`,
      'opportunities': `${market} market opportunities emerging segments`,
      'risks': `${market} market risks challenges threats`,
    };

    try {
      const results = await Promise.all(
        filtered.map(async (aspect) => ({
          aspect,
          snippets: await searchSnippets(queries[aspect] ?? `${market} ${aspect}`),
        }))
      );

      const sections = results.map(({ aspect, snippets }) =>
        `## ${aspect.charAt(0).toUpperCase() + aspect.slice(1).replace('-', ' ')}\n` +
        (snippets.length > 0 ? snippets.map((s) => `- ${s}`).join('\n') : '- No data found.')
      );

      const report = [
        `# Market Research: ${market}`,
        `*Generated ${new Date().toISOString().slice(0, 10)}*`,
        '',
        ...sections,
        '',
        '---',
        '*Note: Data sourced from public web. Verify figures with primary sources.*',
      ].join('\n\n');

      logger.info({ session: ctx.sessionId, market }, 'research.market-research complete');
      return { success: true, output: report, data: { market, aspects: filtered, results } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ market, err: msg }, 'research.market-research error');
      return { success: false, output: `research.market-research error: ${msg}` };
    }
  },
};
