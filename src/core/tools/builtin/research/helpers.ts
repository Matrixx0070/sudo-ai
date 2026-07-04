/**
 * Shared HTTP helpers for the research and learn tool suite.
 *
 * Provides:
 *  - fetchArxiv     — Query arXiv API and return paper entries.
 *  - fetchPubmed    — Query PubMed eutils and return paper entries.
 *  - fetchSemanticScholar — Query Semantic Scholar API.
 *  - fetchPageText  — Fetch a URL and extract plain text.
 *  - stripHtml      — Remove HTML tags and normalise whitespace.
 */

import { createLogger } from '../../../shared/logger.js';
import { toolFetch } from '../../../security/guarded-fetch.js';

const log = createLogger('research-helpers');

const FETCH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PaperEntry {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  url: string;
  source: 'arxiv' | 'pubmed' | 'semantic-scholar';
  year?: string;
}

// ---------------------------------------------------------------------------
// Strip HTML
// ---------------------------------------------------------------------------

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Fetch with timeout helper
// ---------------------------------------------------------------------------

async function timedFetch(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await toolFetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// arXiv API
// ---------------------------------------------------------------------------

export async function fetchArxiv(query: string, maxResults = 5): Promise<PaperEntry[]> {
  const url =
    `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}` +
    `&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`;

  try {
    const res = await timedFetch(url, { headers: { Accept: 'application/atom+xml' } });
    if (!res.ok) {
      log.warn({ status: res.status }, 'arXiv non-200');
      return [];
    }
    const xml = await res.text();
    return parseArxivXml(xml);
  } catch (err) {
    log.error({ err, query }, 'arXiv fetch failed');
    return [];
  }
}

function parseArxivXml(xml: string): PaperEntry[] {
  const entries: PaperEntry[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;

  while ((m = entryPattern.exec(xml)) !== null) {
    const block = m[1] ?? '';
    const id = (/<id>([\s\S]*?)<\/id>/.exec(block)?.[1] ?? '').trim();
    const title = stripHtml((/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? '').trim());
    const abstract = stripHtml((/<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1] ?? '').trim());
    const year = (/<published>(\d{4})/.exec(block)?.[1] ?? undefined);
    const authorMatches = block.matchAll(/<name>([\s\S]*?)<\/name>/g);
    const authors = [...authorMatches].map((a) => stripHtml(a[1] ?? '').trim()).filter(Boolean);

    if (id && title) {
      entries.push({ id, title, authors, abstract, url: id, source: 'arxiv', year });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// PubMed eutils API
// ---------------------------------------------------------------------------

export async function fetchPubmed(query: string, maxResults = 5): Promise<PaperEntry[]> {
  const searchUrl =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}` +
    `&retmax=${maxResults}&retmode=json`;

  try {
    const searchRes = await timedFetch(searchUrl);
    if (!searchRes.ok) return [];
    const searchData = (await searchRes.json()) as { esearchresult?: { idlist?: string[] } };
    const ids: string[] = searchData.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [];

    const summaryUrl =
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}` +
      `&retmode=json`;
    const sumRes = await timedFetch(summaryUrl);
    if (!sumRes.ok) return [];

    const sumData = (await sumRes.json()) as { result?: Record<string, { uid?: string; title?: string; sortfirstauthor?: string; pubdate?: string }> };
    const result = sumData.result ?? {};
    return ids.flatMap((id) => {
      const paper = result[id];
      if (!paper) return [];
      return [{
        id: `pubmed:${id}`,
        title: paper.title ?? `PubMed ${id}`,
        authors: paper.sortfirstauthor ? [paper.sortfirstauthor] : [],
        abstract: '',
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        source: 'pubmed' as const,
        year: paper.pubdate?.slice(0, 4),
      }];
    });
  } catch (err) {
    log.error({ err, query }, 'PubMed fetch failed');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Semantic Scholar API
// ---------------------------------------------------------------------------

export async function fetchSemanticScholar(query: string, maxResults = 5): Promise<PaperEntry[]> {
  const url =
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}` +
    `&limit=${maxResults}&fields=paperId,title,authors,abstract,year,externalIds`;

  try {
    const res = await timedFetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ paperId?: string; title?: string; authors?: Array<{ name: string }>; abstract?: string; year?: number }> };
    return (data.data ?? []).map((p) => ({
      id: `s2:${p.paperId ?? ''}`,
      title: p.title ?? 'Untitled',
      authors: (p.authors ?? []).map((a) => a.name),
      abstract: p.abstract ?? '',
      url: `https://www.semanticscholar.org/paper/${p.paperId ?? ''}`,
      source: 'semantic-scholar' as const,
      year: p.year?.toString(),
    }));
  } catch (err) {
    log.error({ err, query }, 'Semantic Scholar fetch failed');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fetch page text
// ---------------------------------------------------------------------------

export async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await timedFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 SUDO-AI/4.0 research-tool', Accept: 'text/html,text/plain' },
    });
    if (!res.ok) return '';
    const raw = await res.text();
    return stripHtml(raw).slice(0, 8_000);
  } catch (err) {
    log.error({ err, url }, 'fetchPageText failed');
    return '';
  }
}
