/**
 * Skill: research.web-summary
 * Category: research
 * Version: 1.0.0
 *
 * Takes a topic, fetches search results from DuckDuckGo Instant Answer API,
 * optionally fetches and scrapes up to `maxSources` page bodies, then
 * assembles a structured summary with key facts extracted from the text.
 *
 * Uses only Node.js stdlib (https) — no extra deps.
 */

import { request } from 'node:https';
import { IncomingMessage } from 'node:http';
import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../tools/types.js';
import type { ToolRegistry } from '../../../tools/registry.js';

const logger = createLogger('skill.research.web-summary');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebSummaryInput {
  topic: string;
  maxSources: number;
}

export interface WebSummaryOutput {
  summary: string;
  sources: string[];
  keyFacts: string[];
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 12_000;

function httpsGet(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', headers: { 'User-Agent': 'SUDO-AI/3.1 (+research)' } }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Request timeout: ${url}`)); });
    req.on('error', reject);
    req.end();
  });
}

/** Strip HTML tags; collapse whitespace. Returns plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract up to `n` meaningful sentences from plain text. */
function extractSentences(text: string, n: number): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 400)
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// DuckDuckGo Instant Answer
// ---------------------------------------------------------------------------

interface DDGResult {
  Abstract: string;
  AbstractURL: string;
  RelatedTopics: Array<{ Text?: string; FirstURL?: string }>;
}

async function searchDDG(topic: string): Promise<{ abstract: string; url: string; relatedUrls: string[] }> {
  const encoded = encodeURIComponent(topic);
  const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`;
  const raw = await httpsGet(url);
  let parsed: DDGResult;
  try {
    parsed = JSON.parse(raw) as DDGResult;
  } catch {
    return { abstract: '', url: '', relatedUrls: [] };
  }
  const relatedUrls = (parsed.RelatedTopics ?? [])
    .map((t) => t.FirstURL ?? '')
    .filter(Boolean)
    .slice(0, 5);
  return {
    abstract: parsed.Abstract ?? '',
    url: parsed.AbstractURL ?? '',
    relatedUrls,
  };
}

// ---------------------------------------------------------------------------
// Page fetcher
// ---------------------------------------------------------------------------

async function fetchPageSummary(url: string): Promise<{ text: string; url: string } | null> {
  try {
    const html = await httpsGet(url, 8_000);
    const text = stripHtml(html).slice(0, 6_000);
    if (text.length < 100) return null;
    return { text, url };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function webSummary(input: WebSummaryInput, ctx: ToolContext): Promise<WebSummaryOutput> {
  const topic = input.topic.trim();
  const maxSources = Math.max(1, Math.min(input.maxSources ?? 3, 10));

  logger.info({ session: ctx.sessionId, topic, maxSources }, 'research.web-summary starting');

  // 1. DuckDuckGo instant answer
  const ddg = await searchDDG(topic);
  const sources: string[] = [];
  const rawTexts: string[] = [];

  if (ddg.abstract) {
    rawTexts.push(ddg.abstract);
  }
  if (ddg.url) {
    sources.push(ddg.url);
  }

  // 2. Fetch up to maxSources pages (DDG related + abstract URL)
  const urlCandidates = [...ddg.relatedUrls];
  const fetchLimit = Math.min(maxSources, urlCandidates.length);

  const pageResults = await Promise.allSettled(
    urlCandidates.slice(0, fetchLimit).map((u) => fetchPageSummary(u)),
  );

  for (const res of pageResults) {
    if (res.status === 'fulfilled' && res.value) {
      rawTexts.push(res.value.text);
      if (!sources.includes(res.value.url)) {
        sources.push(res.value.url);
      }
    }
  }

  // 3. Extract key facts (sentences)
  const allText = rawTexts.join(' ');
  const keyFacts = extractSentences(allText, 8);

  // 4. Build summary paragraph from first 1000 chars of combined text
  const summaryBase = allText.slice(0, 1_000).replace(/\s+/g, ' ').trim();
  const summary = summaryBase
    ? `${topic}: ${summaryBase}${summaryBase.length >= 1_000 ? '...' : ''}`
    : `No web content found for topic: "${topic}". Try a more specific query.`;

  logger.info({ session: ctx.sessionId, sourcesFound: sources.length, factsFound: keyFacts.length }, 'research.web-summary complete');

  return { summary, sources, keyFacts };
}

// ---------------------------------------------------------------------------
// ToolDefinition
// ---------------------------------------------------------------------------

export const skillTool: ToolDefinition = {
  name: 'research.web-summary',
  description:
    'Search the web for a topic and return a structured summary with key facts and sources. '
    + 'Uses DuckDuckGo Instant Answer + page scraping. '
    + 'Input: { topic, maxSources }. Output: { summary, sources, keyFacts }.',
  category: 'research',
  timeout: 60_000,
  parameters: {
    topic: {
      type: 'string',
      required: true,
      description: 'The topic or question to research.',
    },
    maxSources: {
      type: 'number',
      required: false,
      default: 3,
      description: 'Maximum number of web sources to fetch (1–10, default 3).',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const topic = params['topic'];
    if (typeof topic !== 'string' || !topic.trim()) {
      return { success: false, output: 'research.web-summary: topic is required.' };
    }

    const maxSources = typeof params['maxSources'] === 'number'
      ? params['maxSources']
      : 3;

    try {
      const result = await webSummary({ topic, maxSources }, ctx);
      return {
        success: true,
        output: [
          `Summary: ${result.summary}`,
          `Sources (${result.sources.length}): ${result.sources.join(', ')}`,
          `Key facts (${result.keyFacts.length}):`,
          ...result.keyFacts.map((f, i) => `  ${i + 1}. ${f}`),
        ].join('\n'),
        data: result,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ topic, err: msg }, 'research.web-summary error');
      return { success: false, output: `research.web-summary error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration export (called by skill loader)
// ---------------------------------------------------------------------------

export function registerSkill(registry: ToolRegistry): void {
  registry.register(skillTool);
}

export default skillTool;
