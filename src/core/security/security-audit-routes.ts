/**
 * @file security/security-audit-routes.ts
 * @description REST endpoints for security audit functionality.
 *
 * Endpoints:
 *   POST /v1/admin/security/audit              — run full scan
 *   GET  /v1/admin/security/audit/latest       — latest results
 *   GET  /v1/admin/security/advisories          — list active advisories
 *   POST /v1/admin/security/advisories/:id/acknowledge — dismiss
 *   POST /v1/admin/security/advisories/acknowledge-all — bulk dismiss
 *   GET  /v1/admin/security/components          — list components
 *   GET  /v1/admin/security/summary             — dashboard counts
 *
 * Auth: GATEWAY_TOKEN bearer (timing-safe). All /v1/admin/security/* require auth.
 */

import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import { batchQuery } from './osv-client.js';
import { scanAll, type ComponentInfo } from './component-scanner.js';
import {
  storeScan,
  getLatestScan,
  getAdvisories,
  acknowledgeFinding,
  acknowledgeAll,
  getSummary,
} from './advisory-store.js';

const log = createLogger('security-audit-routes');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY = 64 * 1024; // 64 KB
const SECURITY_BASE = '/v1/admin/security';

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getTokenBuf(): Buffer | null {
  const t = process.env['GATEWAY_TOKEN'];
  return t && t.length > 0 ? Buffer.from(t, 'utf8') : null;
}

function extractBearer(req: IncomingMessage): string {
  const h = req.headers['authorization'] ?? '';
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] ?? '') : '';
}

function isAuthorised(req: IncomingMessage, tokenBuf: Buffer | null): boolean {
  if (tokenBuf === null) return true;
  const candidate = Buffer.from(extractBearer(req), 'utf8');
  return candidate.length === tokenBuf.length && timingSafeEqual(candidate, tokenBuf);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleRunAudit(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (process.env['SUDO_SECURITY_AUDIT_DISABLE'] === '1') {
    sendError(res, 503, 'Security audit disabled via SUDO_SECURITY_AUDIT_DISABLE');
    return;
  }

  try {
    log.info('Starting security audit scan');

    // Scan components
    const components = scanAll();
    log.info({ count: components.length }, 'Components discovered');

    // Query OSV for npm and PyPI packages
    const osvPackages = components
      .filter(c => c.ecosystem === 'npm' || c.ecosystem === 'PyPI')
      .map(c => ({
        name: c.name,
        version: c.version,
        ecosystem: c.ecosystem === 'npm' ? 'npm' as const : 'PyPI' as const,
      }));

    const advisories = await batchQuery(osvPackages);
    log.info({ findings: advisories.length }, 'OSV query complete');

    // Store results
    const scanId = `scan-${randomUUID().slice(0, 8)}`;
    storeScan(scanId, components, advisories);

    sendJson(res, 200, {
      scanId,
      components: components.length,
      findings: advisories.length,
      critical: advisories.filter(a => a.severity === 'CRITICAL').length,
      high: advisories.filter(a => a.severity === 'HIGH').length,
      moderate: advisories.filter(a => a.severity === 'MODERATE').length,
      low: advisories.filter(a => a.severity === 'LOW').length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'Audit scan failed');
    sendError(res, 500, `Audit scan failed: ${msg}`);
  }
}

function handleGetLatest(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const summary = getSummary();
  if (!summary) {
    sendJson(res, 200, { scan: null, message: 'No scans performed yet' });
    return;
  }

  sendJson(res, 200, { scan: summary });
}

function handleListAdvisories(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const severity = url.searchParams.get('severity') ?? undefined;

  const findings = getAdvisories(severity);
  sendJson(res, 200, { advisories: findings, total: findings.length });
}

async function handleAcknowledge(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) {
      body = JSON.parse(raw);
    }
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const reason = (body['reason'] as string) ?? 'No reason provided';

  const updated = acknowledgeFinding(id, reason);
  if (!updated) {
    sendError(res, 404, 'Finding not found or already acknowledged');
    return;
  }

  sendJson(res, 200, { acknowledged: true, findingId: id, reason });
}

async function handleAcknowledgeAll(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) {
      body = JSON.parse(raw);
    }
  } catch {
    body = {};
  }

  const severity = (body['severity'] as string) ?? undefined;
  const count = acknowledgeAll(severity);

  sendJson(res, 200, { acknowledged: true, count, severity: severity ?? 'all' });
}

function handleListComponents(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const components = scanAll();
  sendJson(res, 200, { components, total: components.length });
}

function handleSummary(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const summary = getSummary();
  if (!summary) {
    sendJson(res, 200, { summary: null, message: 'No scans performed yet' });
    return;
  }

  sendJson(res, 200, { summary });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Attach security audit REST routes to an existing http.Server.
 * Non-matching routes fall through to other listeners.
 *
 * @param server - Existing http.Server
 */
export function registerSecurityAuditRoutes(server: HttpServer): void {
  const tokenBuf = getTokenBuf();

  server.on('request', (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? '';
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    const pathname = rawPath.replace(/\/$/, '') || '/';

    // Only handle /v1/admin/security/* paths
    if (!pathname.startsWith(SECURITY_BASE)) return;

    // Auth gate
    if (!isAuthorised(req, tokenBuf)) {
      sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
      return;
    }

    // Parse path segments
    const rest = pathname.slice(SECURITY_BASE.length).replace(/^\//, '') || '';
    const parts = rest.split('/').filter(Boolean);

    const wrap = (p: Promise<void>) => p.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Unhandled security route error');
      if (!res.headersSent) sendError(res, 500, 'Internal server error');
    });

    // POST /v1/admin/security/audit — run scan
    if (method === 'POST' && parts[0] === 'audit' && !parts[1]) {
      wrap(handleRunAudit(req, res));
      return;
    }

    // GET /v1/admin/security/audit/latest — latest results
    if (method === 'GET' && parts[0] === 'audit' && parts[1] === 'latest') {
      handleGetLatest(req, res);
      return;
    }

    // GET /v1/admin/security/advisories — list advisories
    if (method === 'GET' && parts[0] === 'advisories' && !parts[1]) {
      handleListAdvisories(req, res);
      return;
    }

    // POST /v1/admin/security/advisories/:id/acknowledge — dismiss single
    if (method === 'POST' && parts[0] === 'advisories' && parts[2] === 'acknowledge') {
      wrap(handleAcknowledge(req, res, parts[1]!));
      return;
    }

    // POST /v1/admin/security/advisories/acknowledge-all — bulk dismiss
    if (method === 'POST' && parts[0] === 'advisories' && parts[1] === 'acknowledge-all') {
      wrap(handleAcknowledgeAll(req, res));
      return;
    }

    // GET /v1/admin/security/components — list components
    if (method === 'GET' && parts[0] === 'components') {
      handleListComponents(req, res);
      return;
    }

    // GET /v1/admin/security/summary — dashboard summary
    if (method === 'GET' && parts[0] === 'summary') {
      handleSummary(req, res);
      return;
    }

    // No route matched — fall through
  });

  log.info('Security audit routes attached (/v1/admin/security/*)');
}
