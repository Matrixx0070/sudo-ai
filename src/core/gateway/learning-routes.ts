/**
 * @file learning-routes.ts
 * @description HTTP routes for the learning/proposals subsystem (Wave 10).
 *
 * Endpoints:
 *   GET  /v1/admin/learning/proposals                  — C2: list proposals
 *   POST /v1/admin/learning/proposals/:id/approve      — C3: approve proposal
 *   POST /v1/admin/learning/proposals/:id/reject       — C4: reject proposal
 *
 * Auth: timing-safe Bearer token (same pattern as skills/routes.ts).
 * Body: capped at 256 KB.
 * Error shape: { error: { message: string; code: number } }
 *
 * ProposalStore is injected via constructor — Builder 1 implements the concrete class.
 * This file depends only on the duck-typed interface from spec G2.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import type { AgentConfigProposal, ProposalStatus } from '../shared/wave10-types.js';
import { artifactSigner } from '../security/signer.js';

const log = createLogger('gateway:learning-routes');
const MAX_BODY = 256 * 1024;

// ---------------------------------------------------------------------------
// ProposalStore duck-typed interface (spec G2 contract)
// ---------------------------------------------------------------------------

export interface ProposalStoreLike {
  list(filter: { status?: ProposalStatus; limit: number; offset: number }): { data: AgentConfigProposal[]; total: number };
  approve(id: string): AgentConfigProposal;
  reject(id: string, reason?: string): AgentConfigProposal;
  getById(id: string): AgentConfigProposal | null;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface LearningRoutesDeps {
  /** ProposalStore implementing the G2 contract. Required. */
  proposalStore: ProposalStoreLike;
}

// ---------------------------------------------------------------------------
// Auth helpers (self-contained)
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
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, code: status } });
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseQs(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(url.slice(idx + 1)).entries()) {
    out[k] = v;
  }
  return out;
}

/** Extract :id from /v1/admin/learning/proposals/:id/action */
function extractProposalId(pathname: string): string | null {
  const m = /^\/v1\/admin\/learning\/proposals\/([^/]+)\//.exec(pathname);
  return m ? (m[1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set<ProposalStatus>(['pending', 'approved', 'rejected', 'applied']);

/** GET /v1/admin/learning/proposals */
function handleListProposals(req: IncomingMessage, res: ServerResponse, deps: LearningRoutesDeps): void {
  const qs = parseQs(req.url ?? '');
  const statusRaw = qs['status'];
  const limit  = Math.min(parseInt(qs['limit']  ?? '50',  10) || 50,  500);
  const offset = Math.max(parseInt(qs['offset'] ?? '0',   10) || 0,   0);

  let status: ProposalStatus | undefined;
  if (statusRaw) {
    if (!VALID_STATUSES.has(statusRaw as ProposalStatus)) {
      sendError(res, 400, `Invalid status: ${statusRaw}. Valid: pending|approved|rejected|applied`);
      return;
    }
    status = statusRaw as ProposalStatus;
  }

  try {
    const { data, total } = deps.proposalStore.list({ status, limit, offset });
    sendJson(res, 200, { data, total, limit, offset });
  } catch (err) {
    log.error({ err: String(err) }, 'learning-routes: list proposals failed');
    sendError(res, 500, 'Internal server error');
  }
}

/** POST /v1/admin/learning/proposals/:id/approve */
async function handleApprove(req: IncomingMessage, res: ServerResponse, deps: LearningRoutesDeps): Promise<void> {
  const id = extractProposalId(req.url ?? '');
  if (!id) { sendError(res, 400, 'Missing proposal id'); return; }

  // Consume body (spec says {}) but don't use it
  try { await readBody(req); } catch { /* ignore oversized */ }

  try {
    const existing = deps.proposalStore.getById(id);
    if (!existing) { sendError(res, 404, `Proposal not found: ${id}`); return; }
    if (existing.status === 'approved' || existing.status === 'applied') {
      sendError(res, 409, `Proposal already ${existing.status}`);
      return;
    }
    const proposal = deps.proposalStore.approve(id);
    // Wave 10E: sign approved proposal (fail-open).
    let signedArtifact: ReturnType<typeof artifactSigner.sign> | undefined;
    if (process.env['SUDO_SIGNING_DISABLE'] !== '1') {
      try {
        signedArtifact = artifactSigner.sign(proposal, 'config_proposal');
        log.info({ id, keyId: signedArtifact.keyId }, 'learning-routes: proposal signed');
      } catch (signErr) {
        log.warn({ err: String(signErr), id }, 'learning-routes: signing failed — returning unsigned proposal');
      }
    }
    const approveResponse = signedArtifact ? { proposal, signedArtifact } : { proposal };
    sendJson(res, 200, approveResponse);
  } catch (err) {
    log.error({ err: String(err), id }, 'learning-routes: approve proposal failed');
    sendError(res, 500, 'Internal server error');
  }
}

/** POST /v1/admin/learning/proposals/:id/reject */
async function handleReject(req: IncomingMessage, res: ServerResponse, deps: LearningRoutesDeps): Promise<void> {
  const id = extractProposalId(req.url ?? '');
  if (!id) { sendError(res, 400, 'Missing proposal id'); return; }

  let reason: string | undefined;
  try {
    const raw = await readBody(req);
    if (raw.trim()) {
      const body = JSON.parse(raw) as { reason?: string };
      if (typeof body.reason === 'string') reason = body.reason;
    }
  } catch { /* ignore oversized or malformed */ }

  try {
    const existing = deps.proposalStore.getById(id);
    if (!existing) { sendError(res, 404, `Proposal not found: ${id}`); return; }
    if (existing.status === 'approved' || existing.status === 'applied' || existing.status === 'rejected') {
      sendError(res, 409, `Proposal already ${existing.status}`);
      return;
    }
    const proposal = deps.proposalStore.reject(id, reason);
    sendJson(res, 200, { proposal });
  } catch (err) {
    log.error({ err: String(err), id }, 'learning-routes: reject proposal failed');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register learning/proposals routes on the HTTP server.
 *
 * @param server      - Raw node:http Server.
 * @param deps        - LearningRoutesDeps with proposalStore.
 * @param tokenBuf    - Pre-computed GATEWAY_TOKEN buffer for timing-safe auth.
 */
export function registerLearningRoutes(
  server: HttpServer,
  deps: LearningRoutesDeps,
  tokenBuf?: Buffer | null,
): void {
  const tb = tokenBuf !== undefined ? tokenBuf : getTokenBuf();

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method   = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    if (!pathname.startsWith('/v1/admin/learning')) return;
    if (!isAuthorised(req, tb)) { sendError(res, 401, 'Unauthorized'); return; }

    // GET /v1/admin/learning/proposals
    if (method === 'GET' && pathname === '/v1/admin/learning/proposals') {
      handleListProposals(req, res, deps);
      return;
    }

    // POST /v1/admin/learning/proposals/:id/approve
    if (method === 'POST' && pathname.endsWith('/approve')) {
      handleApprove(req, res, deps).catch((err: unknown) => {
        log.error({ err: String(err) }, 'learning-routes: unhandled error in handleApprove');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // POST /v1/admin/learning/proposals/:id/reject
    if (method === 'POST' && pathname.endsWith('/reject')) {
      handleReject(req, res, deps).catch((err: unknown) => {
        log.error({ err: String(err) }, 'learning-routes: unhandled error in handleReject');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    sendError(res, 404, 'Not found');
  });

  log.info('Learning routes registered (/v1/admin/learning/proposals + approve/reject)');
}
