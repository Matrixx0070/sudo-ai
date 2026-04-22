/**
 * @file research-agent.ts
 * @description ResearchAgent — orchestrates multi-source research on a topic
 * by combining web search (fetch-based), Obsidian vault search, and
 * knowledge graph search.
 *
 * Returns a ResearchResult with a synthesised summary, extracted facts,
 * matching graph nodes, vault note paths, and raw web snippets.
 */

import { createLogger } from '../shared/logger.js';
import type { ResearchResult, Fact } from './types.js';
import { ObsidianVault } from './obsidian.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import { extractFacts } from './fact-extractor.js';

const log = createLogger('research-agent');

// ---------------------------------------------------------------------------
// Simple web search via DuckDuckGo Lite HTML (no API key needed)
// ---------------------------------------------------------------------------

async function webSearch(query: string, limit = 5): Promise<string[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 SUDO-AI/3.0 research-agent',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.warn({ status: response.status, query }, 'Web search returned non-200');
      return [];
    }

    const html = await response.text();

    // Extract result snippets using simple regex (no DOM parser needed)
    const snippetPattern = /<a class="result__snippet"[^>]*>([^<]+)<\/a>/g;
    const snippets: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = snippetPattern.exec(html)) !== null && snippets.length < limit) {
      const text = match[1]!
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .trim();
      if (text.length > 20) snippets.push(text);
    }

    log.info({ query, found: snippets.length }, 'Web search complete');
    return snippets;
  } catch (err) {
    log.error({ err, query }, 'Web search failed');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Summariser (simple extractive)
// ---------------------------------------------------------------------------

function extractiveSummary(texts: string[], maxSentences = 5): string {
  const allText = texts.join(' ');
  const sentences = allText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30);

  return sentences.slice(0, maxSentences).join(' ');
}

// ---------------------------------------------------------------------------
// ResearchAgent
// ---------------------------------------------------------------------------

export class ResearchAgent {
  private readonly vault: ObsidianVault;
  private readonly graph: KnowledgeGraph;

  constructor(vault?: ObsidianVault, graph?: KnowledgeGraph) {
    this.vault = vault ?? new ObsidianVault();
    this.graph = graph ?? new KnowledgeGraph();
  }

  /**
   * Research a topic across web, vault, and graph sources.
   *
   * @param topic - Topic or query string to research.
   * @returns     Aggregated ResearchResult.
   */
  async research(topic: string): Promise<ResearchResult> {
    if (!topic || typeof topic !== 'string' || topic.trim() === '') {
      throw new Error('ResearchAgent.research: topic must be a non-empty string');
    }

    log.info({ topic }, 'Research started');

    // Run all sources in parallel
    const [webSnippets, vaultNotes, graphNodes] = await Promise.all([
      webSearch(topic),
      Promise.resolve(this.vault.search(topic, 10).map((n) => n.path)),
      Promise.resolve(this._graphSearch(topic)),
    ]);

    // Combine all text for fact extraction
    const vaultTexts = vaultNotes.map((p) => {
      try {
        const note = this.vault.readNote(p);
        return note?.body ?? '';
      } catch {
        return '';
      }
    });

    const graphTexts = graphNodes.map((n) => `${n.title}: ${n.content}`);
    const allTexts = [...webSnippets, ...vaultTexts, ...graphTexts].filter(Boolean);

    const allFacts: Fact[] = allTexts.flatMap((t) => extractFacts(t));
    const deduped = this._dedupeFacts(allFacts).slice(0, 30);
    const summary = extractiveSummary(allTexts);

    log.info(
      {
        topic,
        webSnippets: webSnippets.length,
        vaultNotes: vaultNotes.length,
        graphNodes: graphNodes.length,
        facts: deduped.length,
      },
      'Research complete',
    );

    return {
      topic,
      summary: summary || `Research on "${topic}" — ${deduped.length} facts extracted.`,
      facts: deduped,
      graphNodes,
      vaultNotes,
      webSnippets,
      researchedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _graphSearch(topic: string) {
    try {
      return this.graph.findNodes(topic, 10);
    } catch {
      return [];
    }
  }

  private _dedupeFacts(facts: Fact[]): Fact[] {
    const seen = new Set<string>();
    return facts.filter((f) => {
      const key = `${f.type}:${f.text.toLowerCase().slice(0, 60)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
