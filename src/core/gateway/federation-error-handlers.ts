/**
 * @file gateway/federation-error-handlers.ts
 * @description Route handlers for federation error endpoints.
 *
 * Part of the Federation Error Protocol.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import type { FederationErrorRoutesDeps, FederationErrorReportRow } from './federation-error-types.js';
import {
  sendJson,
  sendError,
  checkContentLength,
  readBody,
  checkRateLimit,
  isAdminAuthorised,
} from './federation-error-helpers.js';
import {
  validateErrorReport,
  validateFixNotify,
  validateTokenContribution,
} from './federation-error-validators.js';

const log = createLogger('gateway:federation-error-handlers');

// Kill-switches

/**
 * Safe JSON parse that filters prototype pollution keys.
 */
function safeParse(raw: string): unknown {
  return JSON.parse(raw, (key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return undefined;
    }
    return value;
  });
}
const ERROR_REPORT_DISABLE = 'SUDO_FED_ERROR_REPORT_DISABLE';
const FIX_NOTIFY_DISABLE = 'SUDO_FED_FIX_NOTIFY_DISABLE';
const TOKEN_POOL_DISABLE = 'SUDO_FED_TOKEN_POOL_DISABLE';

export async function handleErrorReport(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FederationErrorRoutesDeps,
): Promise<void> {
  if (process.env[ERROR_REPORT_DISABLE] === '1') {
    sendError(res, 503, 'service_unavailable');
    return;
  }

  if (!deps.fedAuth(req)) {
    sendError(res, 401, 'unauthorized');
    return;
  }

  if (!checkContentLength(req)) {
    sendError(res, 413, 'Request body too large');
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 413, 'Request body too large');
    return;
  }

  if (!raw || raw.trim() === '') {
    sendError(res, 400, 'Request body is required');
    return;
  }

  let parsed: unknown;
  try {
    parsed = safeParse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const validation = validateErrorReport(parsed);
  if (!validation.valid) {
    sendError(res, 400, validation.error!);
    return;
  }

  const report = validation.report!;

  const rateCheck = checkRateLimit(report.peerId);
  if (!rateCheck.allowed) {
    if (rateCheck.retryAfter !== undefined) {
      res.setHeader('Retry-After', rateCheck.retryAfter);
    }
    sendError(res, 429, 'rate_limit_exceeded');
    return;
  }

  try {
    const result = await deps.errorIngestor.ingestReport(report);
    sendJson(res, 200, { ok: true, data: result });
    log.info({ peerId: report.peerId, signature: report.errorSignature.slice(0, 50) }, 'error-report ingested');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'error-report ingest failed');
    sendError(res, 500, 'Internal server error');
  }
}

export async function handleFixNotify(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
  deps: FederationErrorRoutesDeps,
): Promise<void> {
  if (process.env[FIX_NOTIFY_DISABLE] === '1') {
    sendError(res, 503, 'service_unavailable');
    return;
  }

  if (!isAdminAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'unauthorized');
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 413, 'Request body too large');
    return;
  }

  if (!raw || raw.trim() === '') {
    sendError(res, 400, 'Request body is required');
    return;
  }

  let parsed: unknown;
  try {
    parsed = safeParse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const validation = validateFixNotify(parsed);
  if (!validation.valid) {
    sendError(res, 400, validation.error!);
    return;
  }

  const fix = validation.fix!;
  const notificationId = `fix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  sendJson(res, 200, { ok: true, data: { notificationId, broadcastToPeers: true } });
  log.info({ notificationId, affectedErrorSignature: fix.affectedErrorSignature.slice(0, 50) }, 'fix-notify broadcast');
}

export async function handleTokenContribute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FederationErrorRoutesDeps,
): Promise<void> {
  if (process.env[TOKEN_POOL_DISABLE] === '1') {
    sendError(res, 503, 'service_unavailable');
    return;
  }

  if (!deps.fedAuth(req)) {
    sendError(res, 401, 'unauthorized');
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 413, 'Request body too large');
    return;
  }

  if (!raw || raw.trim() === '') {
    sendError(res, 400, 'Request body is required');
    return;
  }

  let parsed: unknown;
  try {
    parsed = safeParse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  const validation = validateTokenContribution(parsed);
  if (!validation.valid) {
    sendError(res, 400, validation.error!);
    return;
  }

  const contribution = validation.contribution!;

  try {
    const result = await deps.tokenPool.contributeToken(contribution);
    if (!result.success) {
      sendError(res, 500, 'Failed to store token');
      return;
    }
    sendJson(res, 200, { ok: true, data: { tokenId: result.id } });
    log.info({ peerId: contribution.peerId, provider: contribution.provider }, 'token-contribute accepted');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'token-contribute failed');
    sendError(res, 500, 'Internal server error');
  }
}

/**
 * Check if a meta key contains sensitive patterns that should be redacted.
 */
function isSensitiveKey(key: string): boolean {
  const sensitivePatterns = ['token', 'key', 'secret', 'password', 'credential'];
  const lowerKey = key.toLowerCase();
  return sensitivePatterns.some(pattern => lowerKey.includes(pattern));
}

/**
 * Redact sensitive fields from a meta object.
 */
function redactMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (isSensitiveKey(key)) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactMeta(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * Sanitize report for public response (redact sessionId and sensitive meta).
 */
function sanitizeReport(report: FederationErrorReportRow): FederationErrorReportRow {
  return {
    ...report,
    sessionId: report.sessionId !== undefined ? '***' : undefined,
    meta: redactMeta(report.meta),
  };
}

export function handleErrorReports(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
  deps: FederationErrorRoutesDeps,
): void {
  if (!isAdminAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'unauthorized');
    return;
  }

  const urlObj = new URL(req.url ?? '/', 'http://localhost');
  const peerId = urlObj.searchParams.get('peerId') ?? undefined;
  const signature = urlObj.searchParams.get('signature') ?? undefined;
  const limitParam = urlObj.searchParams.get('limit');

  let limit: number = 50;
  if (limitParam !== null && limitParam !== '') {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      sendError(res, 400, 'limit must be a positive integer');
      return;
    }
    limit = Math.min(parsed, 500);
  }

  try {
    const reports = deps.errorIngestor.queryReports({ peerId, signature, limit });
    // Sanitize reports: redact sessionId and sensitive meta fields
    const sanitizedReports = reports.map(sanitizeReport);
    sendJson(res, 200, { ok: true, data: { reports: sanitizedReports, count: sanitizedReports.length } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'error-reports query failed');
    sendError(res, 500, 'Internal server error');
  }
}

export function handleTokenPool(
  req: IncomingMessage,
  res: ServerResponse,
  adminTokenBuf: Buffer | null,
  deps: FederationErrorRoutesDeps,
): void {
  if (!isAdminAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'unauthorized');
    return;
  }

  const urlObj = new URL(req.url ?? '/', 'http://localhost');
  const peerId = urlObj.searchParams.get('peerId') ?? undefined;
  const activeOnly = urlObj.searchParams.get('activeOnly') === 'true';

  const tokens = deps.tokenPool.listTokens({ peerId, activeOnly });
  sendJson(res, 200, { ok: true, data: { tokens, count: tokens.length } });
}
