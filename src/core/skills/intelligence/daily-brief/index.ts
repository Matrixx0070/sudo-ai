/**
 * Skill: intelligence.daily-brief
 * Category: intelligence
 * Version: 1.0.0
 *
 * Generates a daily intelligence briefing by aggregating:
 * Data sources: HN Algolia API, GitHub Trending (HTML scrape),
 * mind.db cron health, mind.db content idea backlog.
 * Optional `focus` param filters which sections to include.
 * Returns: { brief, actionItems, opportunities }
 */

import { request } from 'node:https';
import { IncomingMessage } from 'node:http';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { createLogger } from '../../../shared/logger.js';
import { MIND_DB } from '../../../shared/paths.js';
import { dailyBudgetUsd } from '../../../billing/daily-budget.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../tools/types.js';
import type { ToolRegistry } from '../../../tools/registry.js';

const logger = createLogger('skill.intelligence.daily-brief');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_PATH = MIND_DB;
const REQUEST_TIMEOUT = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DailyBriefInput {
  focus?: string;
}

export interface DailyBriefOutput {
  brief: string;
  actionItems: string[];
  opportunities: string[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function httpsGet(url: string, timeoutMs = REQUEST_TIMEOUT): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'GET', headers: { 'User-Agent': 'SUDO-AI/3.1 (+intelligence)' } },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Section: Hacker News
// ---------------------------------------------------------------------------

interface HNStory {
  objectID: string;
  title: string;
  url?: string;
  points: number;
  num_comments: number;
}

interface HNSearchResult {
  hits: HNStory[];
}

async function fetchHNTop5(): Promise<string[]> {
  try {
    const json = await httpsGet(
      'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=5',
    );
    const data = JSON.parse(json) as HNSearchResult;
    return data.hits.map(
      (h) => `[HN ${h.points}pts] ${h.title} ${h.url ? `(${h.url.slice(0, 60)})` : ''}`,
    );
  } catch (err) {
    logger.warn({ err }, 'HN fetch failed');
    return ['[HN] Could not fetch Hacker News — network may be restricted'];
  }
}

// ---------------------------------------------------------------------------
// Section: GitHub Trending
// ---------------------------------------------------------------------------

function parseGitHubTrending(html: string): string[] {
  // Extract repo names from <h2 class="h3 lh-condensed"> ... </h2> in trending page
  const matches = [...html.matchAll(/<h2[^>]*class="[^"]*lh-condensed[^"]*"[^>]*>([\s\S]*?)<\/h2>/g)];
  return matches
    .map((m) => (m[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 5);
}

async function fetchGitHubTrending(): Promise<string[]> {
  try {
    const html = await httpsGet('https://github.com/trending?since=daily&spoken_language_code=en');
    const repos = parseGitHubTrending(html);
    if (repos.length === 0) return ['[GitHub] Could not parse trending repos'];
    return repos.map((r) => `[GH Trending] ${r}`);
  } catch (err) {
    logger.warn({ err }, 'GitHub trending fetch failed');
    return ['[GitHub] Could not fetch trending — network may be restricted'];
  }
}

// ---------------------------------------------------------------------------
// Section: System health from DB
// ---------------------------------------------------------------------------

interface SystemHealthSummary {
  cronFailures: string[];
  costToday: number;
  pendingIdeas: number;
}

function fetchSystemHealth(): SystemHealthSummary {
  const result: SystemHealthSummary = { cronFailures: [], costToday: 0, pendingIdeas: 0 };
  if (!existsSync(DB_PATH)) return result;

  try {
    const db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = WAL');

    // Cron failures last 24h
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const cronFails = db.prepare<{ cutoff: string }, { job_name: string; error: string | null }>(`
      SELECT job_name, error FROM cron_runs WHERE status = 'failed' AND ran_at > :cutoff ORDER BY ran_at DESC LIMIT 5
    `).all({ cutoff });
    result.cronFailures = cronFails.map((r) => `${r.job_name}${r.error ? `: ${r.error.slice(0, 80)}` : ''}`);

    // API cost today. Real spend is recorded in api_call_log (by the
    // cost-tracker); the legacy api_costs table is never populated, so the
    // prior query always summed to $0. Half-open [today, tomorrow) UTC window
    // mirrors CostTracker.getTodayCost(); called_at is full ISO, so the
    // YYYY-MM-DD bounds compare lexicographically as day edges.
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const costRow = db.prepare<{ today: string; tomorrow: string }, { total: number }>(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) as total
      FROM api_call_log WHERE called_at >= :today AND called_at < :tomorrow
    `).get({ today, tomorrow });
    result.costToday = costRow?.total ?? 0;

    // Pending content ideas
    const ideasRow = db.prepare<[], { count: number }>(
      "SELECT COUNT(*) as count FROM content_ideas WHERE status = 'pending'",
    ).get();
    result.pendingIdeas = ideasRow?.count ?? 0;

    db.close();
  } catch (err) {
    logger.warn({ err }, 'DB health fetch failed — using empty defaults');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Brief assembler
// ---------------------------------------------------------------------------

async function buildBrief(input: DailyBriefInput, ctx: ToolContext): Promise<DailyBriefOutput> {
  const focus = input.focus?.toLowerCase() ?? 'all';
  const now = new Date().toISOString();
  logger.info({ session: ctx.sessionId, focus }, 'intelligence.daily-brief building');

  // Fetch sections in parallel
  const [hnStories, ghRepos] = await Promise.all([
    focus === 'system' ? Promise.resolve<string[]>([]) : fetchHNTop5(),
    focus === 'system' ? Promise.resolve<string[]>([]) : fetchGitHubTrending(),
  ]);
  const health = fetchSystemHealth();

  const sections: string[] = [];
  const actionItems: string[] = [];
  const opportunities: string[] = [];

  // Date header
  sections.push(`## SUDO-AI Daily Brief — ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  sections.push('');

  // HN section
  if (hnStories.length > 0 && focus !== 'system') {
    sections.push('### Hacker News — Top Today');
    hnStories.forEach((s) => sections.push(`- ${s}`));
    sections.push('');
    // Look for AI/content opportunities
    const aiHits = hnStories.filter((s) => /AI|LLM|GPT|model|agent/i.test(s));
    if (aiHits.length > 0) {
      opportunities.push(`AI trending on HN today — good time for AI reaction content: ${aiHits[0]?.slice(0, 100)}`);
    }
  }

  // GitHub trending
  if (ghRepos.length > 0 && focus !== 'system') {
    sections.push('### GitHub Trending — Today');
    ghRepos.forEach((r) => sections.push(`- ${r}`));
    sections.push('');
    const devTools = ghRepos.filter((r) => /tool|cli|agent|automation|ai/i.test(r));
    if (devTools.length > 0) {
      opportunities.push(`New dev tools trending: ${devTools[0]?.slice(0, 80)} — possible "top tools" Short topic`);
    }
  }

  // System health section
  sections.push('### System Health');
  sections.push(`- API cost today: $${health.costToday.toFixed(4)}`);
  sections.push(`- Pending content ideas: ${health.pendingIdeas}`);
  if (health.cronFailures.length > 0) {
    sections.push(`- CRON FAILURES (${health.cronFailures.length}): ${health.cronFailures.slice(0, 3).join(', ')}`);
    health.cronFailures.forEach((f) => actionItems.push(`Fix cron failure: ${f}`));
  } else {
    sections.push('- Cron jobs: all healthy');
  }
  sections.push('');

  // Action items
  // Flag when today's spend crosses 80% of the configurable daily budget
  // (default $5 → $4), matching the self-diagnostic warn tier.
  if (health.costToday > dailyBudgetUsd() * 0.8) {
    actionItems.push(`API costs high today ($${health.costToday.toFixed(3)}) — review usage`);
  }
  if (health.pendingIdeas > 10) {
    actionItems.push(`${health.pendingIdeas} content ideas pending — review and approve or reject`);
  }
  if (actionItems.length === 0) {
    actionItems.push('No urgent action items — system healthy');
  }

  const brief = sections.join('\n');
  logger.info({ session: ctx.sessionId, sections: sections.length, actionItems: actionItems.length }, 'intelligence.daily-brief complete');
  return { brief, actionItems, opportunities, generatedAt: now };
}

// ---------------------------------------------------------------------------
// ToolDefinition
// ---------------------------------------------------------------------------

export const skillTool: ToolDefinition = {
  name: 'intelligence.daily-brief',
  description:
    'Generate a daily intelligence briefing aggregating HN trending, GitHub trending, '
    + 'system health (cron failures, API costs), and content idea backlog. '
    + 'Input: { focus? }. Output: { brief, actionItems, opportunities }.',
  category: 'research',
  timeout: 45_000,
  parameters: {
    focus: {
      type: 'string',
      required: false,
      description: 'Optional section filter: "tech" (HN+GitHub only), "system" (health only), or omit for all.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const focus = typeof params['focus'] === 'string' ? params['focus'] : undefined;
    try {
      const result = await buildBrief({ focus }, ctx);
      return {
        success: true,
        output: [
          result.brief,
          '',
          `Action Items (${result.actionItems.length}):`,
          ...result.actionItems.map((a) => `  - ${a}`),
          '',
          `Opportunities (${result.opportunities.length}):`,
          ...result.opportunities.map((o) => `  - ${o}`),
        ].join('\n'),
        data: result,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'intelligence.daily-brief error');
      return { success: false, output: `intelligence.daily-brief error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration export
// ---------------------------------------------------------------------------

export function registerSkill(registry: ToolRegistry): void {
  registry.register(skillTool);
}

export default skillTool;
