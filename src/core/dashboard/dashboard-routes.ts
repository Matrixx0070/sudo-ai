/**
 * dashboard-routes.ts
 *
 * HTTP route handlers for the SUDO-AI dashboard.
 *
 * Routes:
 *   GET /              — Dashboard HTML UI
 *   GET /api/stats     — DashboardStats JSON (Bearer-gated)
 *   GET /api/health    — DashboardHealth JSON (Bearer-gated)
 *   GET /api/metrics   — Prometheus text metrics (Bearer-gated)
 *   GET /api/alignment — Alignment data (Bearer-gated)
 *   GET /api/activity?limit=50 — Recent activity (Bearer-gated)
 *   GET /api/agents/live — FleetView live agent snapshot (Bearer-gated, gap #25 slice 1)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DashboardServer } from './dashboard-server.js';
import type { DashboardConfig } from './dashboard-types.js';
import { DASHBOARD_HTML } from './dashboard-html.js';

const log = {
  info: (msg: object) => {
    const timestamp = new Date().toISOString();
    process.stdout.write(`[${timestamp}] [dashboard-routes] ${JSON.stringify(msg)}\n`);
  },
  warn: (msg: object) => {
    const timestamp = new Date().toISOString();
    process.stderr.write(`[${timestamp}] [dashboard-routes] ${JSON.stringify(msg)}\n`);
  },
};

/** Validate Bearer token for /api/* routes. */
function validateAuth(req: IncomingMessage, config: DashboardConfig): boolean {
  const authHeader = req.headers.authorization ?? '';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const queryToken = url.searchParams.get('token');

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token === config.authToken) return true;
  }

  if (queryToken === config.authToken) return true;
  return false;
}

/** Send JSON response. */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Send plain text response. */
function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain'): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

/** Route handler registration. */
export function registerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  server: DashboardServer,
  config: DashboardConfig
): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';

  // Only GET requests supported
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // Route: Dashboard HTML (no auth required)
  if (pathname === '/') {
    sendText(res, 200, DASHBOARD_HTML, 'text/html');
    return;
  }

  // All /api/* routes require authentication
  if (!pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  if (!validateAuth(req, config)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  // Route: /api/stats
  if (pathname === '/api/stats') {
    sendJson(res, 200, server.getStats());
    return;
  }

  // Route: /api/health
  if (pathname === '/api/health') {
    sendJson(res, 200, server.getHealth());
    return;
  }

  // Route: /api/metrics (Prometheus format)
  if (pathname === '/api/metrics') {
    const metrics = server.getMetrics();
    const prometheusText = Object.entries(metrics).map(([key, value]) => `${key} ${value}`).join('\n');
    sendText(res, 200, prometheusText + '\n', 'text/plain; version=0.0.4');
    return;
  }

  // Route: /api/alignment
  if (pathname === '/api/alignment') {
    sendJson(res, 200, server.getAlignment());
    return;
  }

  // Route: /api/activity
  if (pathname === '/api/activity') {
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    sendJson(res, 200, server.getRecentActivity(limit));
    return;
  }

  // Route: /api/agents/live — FleetView (gap #25 slice 1)
  if (pathname === '/api/agents/live') {
    sendJson(res, 200, server.getLiveAgents());
    return;
  }

  // Unknown route
  sendJson(res, 404, { error: 'Not found' });
}
