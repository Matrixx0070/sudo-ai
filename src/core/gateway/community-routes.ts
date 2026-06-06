/**
 * @file community-routes.ts
 * @description Gateway routes for community-driven features.
 *
 * Exposes the new community-requested features via HTTP API:
 *   - GET /api/briefing      — Generate or read HEARTBEAT morning briefing
 *   - GET /api/costs         — Cost transparency report with competitor comparison
 *   - GET /api/costs/compare — Side-by-side cost comparison vs competitors
 *   - GET /api/skills/marketplace — Search the skills marketplace
 *   - POST /api/skills/marketplace — Publish a skill
 *   - POST /api/migration/openclaw — Migrate from OpenClaw
 *   - POST /api/migration/hermes   — Migrate from Hermes
 *   - GET /api/comparison   — Feature comparison table
 *   - GET /api/guard/status — Self-improvement safety guard status
 *   - GET /api/guard/pending — Pending improvements awaiting review
 *   - POST /api/guard/review — Review a pending improvement
 */

import { createLogger } from '../shared/logger.js';
import type { IncomingMessage, ServerResponse } from 'http';

const log = createLogger('gateway:community-routes');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RouteContext {
  heartbeat: import('../consciousness/heartbeat.js').HeartbeatEngine | null;
  costReporter: import('../billing/cost-reporter.js').CostReporter | null;
  marketplace: import('../skills/marketplace.js').SkillsMarketplace | null;
  migration: import('../tools/migration-toolkit.js').MigrationToolkit | null;
  guard: import('../learning/self-improvement-guard.js').SelfImprovementGuard | null;
  verifier: import('../tools/completion-verifier.js').CompletionVerifier | null;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Register community-driven feature routes on the HTTP server.
 */
export function registerCommunityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? '/';
  const path = url.split('?')[0];
  const method = req.method ?? 'GET';

  // GET /api/briefing — Generate or read HEARTBEAT morning briefing
  if (path === '/api/briefing' && method === 'GET') {
    return handleBriefing(req, res, ctx);
  }

  // GET /api/costs — Cost transparency report
  if (path === '/api/costs' && method === 'GET') {
    return handleCosts(req, res, ctx);
  }

  // GET /api/costs/compare — Competitor cost comparison
  if (path === '/api/costs/compare' && method === 'GET') {
    return handleCostComparison(req, res, ctx);
  }

  // GET /api/skills/marketplace — Search marketplace
  if (path === '/api/skills/marketplace' && method === 'GET') {
    return handleMarketplaceSearch(req, res, ctx);
  }

  // POST /api/skills/marketplace — Publish a skill
  if (path === '/api/skills/marketplace' && method === 'POST') {
    return handleMarketplacePublish(req, res, ctx);
  }

  // POST /api/migration/openclaw — Migrate from OpenClaw
  if (path === '/api/migration/openclaw' && method === 'POST') {
    return handleMigration(req, res, ctx, 'openclaw');
  }

  // POST /api/migration/hermes — Migrate from Hermes
  if (path === '/api/migration/hermes' && method === 'POST') {
    return handleMigration(req, res, ctx, 'hermes');
  }

  // GET /api/comparison — Feature comparison table
  if (path === '/api/comparison' && method === 'GET') {
    return handleComparison(req, res, ctx);
  }

  // GET /api/guard/status — Safety guard status
  if (path === '/api/guard/status' && method === 'GET') {
    return handleGuardStatus(req, res, ctx);
  }

  // GET /api/guard/pending — Pending improvements
  if (path === '/api/guard/pending' && method === 'GET') {
    return handleGuardPending(req, res, ctx);
  }

  // POST /api/guard/review — Review improvement
  if (path === '/api/guard/review' && method === 'POST') {
    return handleGuardReview(req, res, ctx);
  }

  // GET /api/verifier/stats — Completion verifier stats
  if (path === '/api/verifier/stats' && method === 'GET') {
    return handleVerifierStats(req, res, ctx);
  }

  // No matching route
  return false;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleBriefing(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (!ctx.heartbeat) {
    jsonReply(res, 503, { error: 'Heartbeat engine not available' });
    return true;
  }

  // Check if we should generate a new briefing or return existing
  const url = req.url ?? '';
  const generate = url.includes('generate=true');

  if (generate) {
    ctx.heartbeat.generateBriefing().then(briefing => {
      jsonReply(res, 200, { status: 'generated', briefing });
    }).catch(err => {
      jsonReply(res, 500, { error: String(err) });
    });
  } else {
    const existing = ctx.heartbeat.readCurrentBriefing();
    if (existing) {
      res.writeHead(200, { 'Content-Type': 'text/markdown' });
      res.end(existing);
    } else {
      jsonReply(res, 404, { error: 'No briefing generated yet. Use ?generate=true' });
    }
  }

  return true;
}

function handleCosts(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (!ctx.costReporter) {
    jsonReply(res, 503, { error: 'Cost reporter not available' });
    return true;
  }

  const url = req.url ?? '';
  const format = url.includes('format=markdown') ? 'markdown' : 'json';

  if (format === 'markdown') {
    const md = ctx.costReporter.generateMarkdownReport();
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(md);
  } else {
    const report = ctx.costReporter.generateReport();
    jsonReply(res, 200, report);
  }

  return true;
}

function handleCostComparison(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (!ctx.costReporter) {
    jsonReply(res, 503, { error: 'Cost reporter not available' });
    return true;
  }

  const comparisons = ctx.costReporter.getCompetitorComparison();
  jsonReply(res, 200, { comparisons });

  return true;
}

function handleMarketplaceSearch(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (!ctx.marketplace) {
    jsonReply(res, 503, { error: 'Marketplace not available' });
    return true;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const results = ctx.marketplace.search({
    query: url.searchParams.get('q') ?? undefined,
    category: url.searchParams.get('category') ?? undefined,
    sortBy: (url.searchParams.get('sort') as 'downloads' | 'rating' | 'recent' | 'name') ?? undefined,
    limit: parseInt(url.searchParams.get('limit') ?? '20', 10),
    offset: parseInt(url.searchParams.get('offset') ?? '0', 10),
  });

  jsonReply(res, 200, { results, total: results.length });

  return true;
}

function handleMarketplacePublish(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (!ctx.marketplace) {
    jsonReply(res, 503, { error: 'Marketplace not available' });
    return true;
  }

  readBody(req).then(body => {
    try {
      const data = JSON.parse(body);
      const skill = ctx.marketplace!.publish(data.manifest, data.body, data.source);
      jsonReply(res, 201, { status: 'published', skill });
    } catch (err) {
      jsonReply(res, 400, { error: String(err) });
    }
  }).catch(err => {
    jsonReply(res, 500, { error: String(err) });
  });

  return true;
}

function handleMigration(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  source: 'openclaw' | 'hermes',
): boolean {
  if (!ctx.migration) {
    jsonReply(res, 503, { error: 'Migration toolkit not available' });
    return true;
  }

  readBody(req).then(body => {
    try {
      const data = JSON.parse(body);
      const result = source === 'openclaw'
        ? ctx.migration!.migrateOpenClaw(data)
        : ctx.migration!.migrateHermes(data);

      jsonReply(res, 200, result);
    } catch (err) {
      jsonReply(res, 400, { error: String(err) });
    }
  }).catch(err => {
    jsonReply(res, 500, { error: String(err) });
  });

  return true;
}

function handleComparison(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (!ctx.migration) {
    jsonReply(res, 503, { error: 'Migration toolkit not available' });
    return true;
  }

  const url = req.url ?? '';
  const format = url.includes('format=markdown') ? 'markdown' : 'json';

  if (format === 'markdown') {
    const md = ctx.migration.generateComparison();
    res.writeHead(200, { 'Content-Type': 'text/markdown' });
    res.end(md);
  } else {
    const data = ctx.migration.getComparisonData();
    jsonReply(res, 200, { comparison: data });
  }

  return true;
}

function handleGuardStatus(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (!ctx.guard) {
    jsonReply(res, 503, { error: 'Safety guard not available' });
    return true;
  }

  const stats = ctx.guard.getStats();
  jsonReply(res, 200, { guard: stats, killSwitchActive: ctx.guard.isKillSwitchActive() });

  return true;
}

function handleGuardPending(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (!ctx.guard) {
    jsonReply(res, 503, { error: 'Safety guard not available' });
    return true;
  }

  const pending = ctx.guard.getPending();
  jsonReply(res, 200, { pending, count: pending.length });

  return true;
}

function handleGuardReview(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (!ctx.guard) {
    jsonReply(res, 503, { error: 'Safety guard not available' });
    return true;
  }

  readBody(req).then(body => {
    try {
      const data = JSON.parse(body);
      const result = ctx.guard!.review({
        improvementId: data.improvementId,
        action: data.action,
        note: data.note,
        reviewer: data.reviewer ?? 'api',
      });

      if (result) {
        jsonReply(res, 200, { status: 'reviewed', improvement: result });
      } else {
        jsonReply(res, 404, { error: 'Improvement not found' });
      }
    } catch (err) {
      jsonReply(res, 400, { error: String(err) });
    }
  }).catch(err => {
    jsonReply(res, 500, { error: String(err) });
  });

  return true;
}

function handleVerifierStats(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  if (!ctx.verifier) {
    jsonReply(res, 503, { error: 'Completion verifier not available' });
    return true;
  }

  const stats = ctx.verifier.getStats();
  jsonReply(res, 200, stats);

  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonReply(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}