/**
 * @file gateway/federation-routes.ts
 * @description Federation REST route handlers.
 *
 * Routes:
 *   POST /v1/federation/audit/ingest  — inbound from trusted peer (federation bearer)
 *   GET  /v1/federation/audit/tail    — peer reads our audit tail (federation bearer)
 *   GET  /v1/federation/peers         — list configured peers (admin bearer)
 *   GET  /v1/federation/stats         — federation telemetry (admin bearer)
 *   GET  /v1/federation/public-key    — export our public key for peer verification (federation bearer)
 *
 * Auth:
 *   /ingest, /tail, /public-key  → SUDO_FEDERATION_INBOUND_TOKENS (via PeerRegistry.isInboundTokenValid)
 *   /peers and /stats  → GATEWAY_TOKEN (admin bearer, same as admin-routes.ts)
 *
 * Wave 7E — federation MVP.
 * Wave 10H — public-key endpoint + verify-on-ingest.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../shared/logger.js';
import type { PeerRegistry } from '../federation/peer-registry.js';
import type { AuditChainSync, FederatedEvent } from '../federation/audit-chain-sync.js';
import type { PeerKeyFetcher } from '../federation/peer-key-fetcher.js';
import type { ArtifactSigner } from '../security/signer.js';
import type { SignedArtifact } from '../shared/wave10-types.js';

const log = createLogger('gateway:federation-routes');

const MAX_BODY = 64 * 1024; // 64 KB — federation events are small
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_SINCE_OFFSET_MS = 60_000; // 1 minute lookback if not specified

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface FederationRoutesDeps {
  peerRegistry: PeerRegistry;
  auditChainSync: AuditChainSync;
  // Wave 10H additions:
  /** When absent, verify-on-ingest is skipped entirely (backward compat). */
  peerKeyFetcher?: PeerKeyFetcher;
  /** For GET /v1/federation/public-key. When absent, endpoint returns 503. */
  artifactSigner?: ArtifactSigner;
}

// ---------------------------------------------------------------------------
// Internal helpers
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
  sendJson(res, status, { ok: false, error: message });
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

function extractBearer(req: IncomingMessage): string {
  const h = req.headers['authorization'] ?? '';
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] ?? '') : '';
}

function isAdminAuthorised(req: IncomingMessage, adminTokenBuf: Buffer | null): boolean {
  if (adminTokenBuf === null) return true;
  const candidate = Buffer.from(extractBearer(req), 'utf8');
  return candidate.length === adminTokenBuf.length && timingSafeEqual(candidate, adminTokenBuf);
}

function isFederationAuthorised(req: IncomingMessage, registry: PeerRegistry): boolean {
  const candidate = extractBearer(req);
  return registry.isInboundTokenValid(candidate);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /v1/federation/public-key
 * Auth: federation bearer token (isFederationAuthorised).
 * Note: SUDO_FED_VERIFY_DISABLE does NOT gate this endpoint.
 *   That kill-switch controls inbound verify; peers may always read our public key.
 */
function handlePublicKey(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FederationRoutesDeps,
): void {
  if (!isFederationAuthorised(req, deps.peerRegistry)) {
    sendError(res, 401, 'unauthorized');
    return;
  }

  if (!deps.artifactSigner) {
    sendError(res, 503, 'signer_not_available');
    return;
  }

  try {
    const data = deps.artifactSigner.getPublicKey();
    sendJson(res, 200, { ok: true, data });
    log.debug({ keyId: data.keyId }, 'Federation: public-key served to peer');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'Federation: getPublicKey threw');
    sendError(res, 500, 'Internal server error');
  }
}

async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FederationRoutesDeps,
): Promise<void> {
  if (!isFederationAuthorised(req, deps.peerRegistry)) {
    sendError(res, 401, 'Unauthorized: invalid or missing federation bearer token');
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 400, 'Request body too large or unreadable');
    return;
  }

  if (!raw || raw.trim() === '') {
    sendError(res, 400, 'Request body is required');
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    sendError(res, 400, 'Invalid JSON body');
    return;
  }

  // Validate envelope shape
  if (typeof event !== 'object' || event === null) {
    sendError(res, 400, 'Body must be a JSON object');
    return;
  }

  const ev = event as Record<string, unknown>;
  if (typeof ev['instanceId'] !== 'string' || ev['instanceId'].trim() === '') {
    sendError(res, 400, 'instanceId is required and must be a non-empty string');
    return;
  }
  if (typeof ev['eventType'] !== 'string' || ev['eventType'].trim() === '') {
    sendError(res, 400, 'eventType is required and must be a non-empty string');
    return;
  }
  if (typeof ev['ts'] !== 'number' || !Number.isFinite(ev['ts']) || ev['ts'] <= 0) {
    sendError(res, 400, 'ts must be a positive number (epoch ms)');
    return;
  }
  if (typeof ev['seq'] !== 'number' || !Number.isInteger(ev['seq']) || ev['seq'] < 1) {
    sendError(res, 400, 'seq must be a positive integer');
    return;
  }

  const fedEvent: FederatedEvent = {
    id: typeof ev['id'] === 'string' && ev['id'].trim() !== '' ? ev['id'] : `auto-${Date.now()}`,
    instanceId: ev['instanceId'] as string,
    eventType: ev['eventType'] as string,
    payload: ev['payload'] ?? null,
    ts: ev['ts'] as number,
    seq: ev['seq'] as number,
  };

  // ---------------------------------------------------------------------------
  // Wave 10H — optional verify-on-ingest
  // Read signature fields from raw ev (not fedEvent — FederatedEvent has no sig fields).
  // ---------------------------------------------------------------------------
  if (process.env['SUDO_FED_VERIFY_DISABLE'] !== '1' && deps.peerKeyFetcher && deps.artifactSigner) {
    const strict = process.env['SUDO_FED_STRICT_VERIFY'] === '1';

    // Extract signature fields from raw parsed JSON.
    const rawKeyId = typeof ev['keyId'] === 'string' ? ev['keyId'] : undefined;
    const rawSig = typeof ev['signature'] === 'string' ? ev['signature'] : undefined;
    const rawSignedAt = typeof ev['signedAt'] === 'string' ? ev['signedAt'] : undefined;
    const rawKeyVersion = typeof ev['keyVersion'] === 'number' ? ev['keyVersion'] : undefined;

    // All four fields must be present for the signed path; any missing → unsigned path.
    const hasAllSigFields =
      rawKeyId !== undefined &&
      rawSig !== undefined &&
      rawSignedAt !== undefined &&
      rawKeyVersion !== undefined;

    if (!hasAllSigFields) {
      // Unsigned event path.
      if (strict) {
        log.warn({ eventId: String(fedEvent.id).slice(0, 128), strict: true }, 'fed.ingest.signature_required_rejected');
        sendError(res, 400, 'signature_required');
        return;
      }
      log.warn({ eventId: String(fedEvent.id).slice(0, 128) }, 'fed.ingest.unsigned_accepted');
      // fall through to existing accept path
    } else {
      // Signed event path.
      let keyEntry = await deps.peerKeyFetcher.fetchForKeyId(rawKeyId!);

      if (!keyEntry) {
        if (strict) {
          log.warn({ keyId: String(rawKeyId).slice(0, 128), strict: true }, 'fed.ingest.key_unknown_rejected');
          sendError(res, 400, 'verification_failed');
          return;
        }
        log.warn({ keyId: String(rawKeyId).slice(0, 128) }, 'fed.ingest.key_unknown_accepted');
        // fall through
      } else {
        const artifact: SignedArtifact = {
          payload: fedEvent.payload,
          signedAt: rawSignedAt!,
          keyId: rawKeyId!,
          keyVersion: rawKeyVersion!,
          signature: rawSig!,
          artifactType: 'federation_event',
        };

        let valid = deps.artifactSigner.verifyWithPublicKey(artifact, keyEntry.publicKeyDerHex);

        if (!valid) {
          // Cache might be stale — refetch once and retry.
          keyEntry = await deps.peerKeyFetcher.refetchForKeyId(rawKeyId!);
          if (keyEntry) {
            valid = deps.artifactSigner.verifyWithPublicKey(artifact, keyEntry.publicKeyDerHex);
          }
          if (!valid) {
            // Hard reject regardless of fail-open — cryptographic forgery.
            log.warn({ eventId: String(fedEvent.id).slice(0, 128), keyId: String(rawKeyId).slice(0, 128) }, 'fed.ingest.signature_invalid_rejected');
            sendError(res, 400, 'signature_invalid');
            return;
          }
        }

        log.debug({ eventId: fedEvent.id, peerName: keyEntry!.peerName }, 'fed.ingest.verified');
      }
    }
  }

  const result = deps.auditChainSync.ingestEvent(fedEvent);
  if (result === 'duplicate') {
    sendJson(res, 409, { ok: false, error: 'Duplicate event (instanceId+seq already exists)' });
    return;
  }
  if (result === 'error') {
    sendError(res, 500, 'Internal server error storing event');
    return;
  }

  log.info(
    { instanceId: fedEvent.instanceId, seq: fedEvent.seq, eventType: fedEvent.eventType },
    'Federation: inbound event ingested',
  );
  sendJson(res, 200, { ok: true, data: { id: fedEvent.id, seq: fedEvent.seq } });
}

function handleTail(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FederationRoutesDeps,
): void {
  if (!isFederationAuthorised(req, deps.peerRegistry)) {
    sendError(res, 401, 'Unauthorized: invalid or missing federation bearer token');
    return;
  }

  const urlObj = new URL(req.url ?? '/', 'http://localhost');
  const sinceParam = urlObj.searchParams.get('since');
  const limitParam = urlObj.searchParams.get('limit');

  let since: number;
  if (sinceParam !== null && sinceParam !== '') {
    const parsed = Number(sinceParam);
    if (!Number.isFinite(parsed) || parsed < 0) {
      sendError(res, 400, 'since must be a non-negative number (epoch ms)');
      return;
    }
    since = parsed;
  } else {
    since = Date.now() - DEFAULT_SINCE_OFFSET_MS;
  }

  let limit: number;
  if (limitParam !== null && limitParam !== '') {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      sendError(res, 400, 'limit must be a positive integer');
      return;
    }
    limit = Math.min(parsed, MAX_LIMIT);
  } else {
    limit = DEFAULT_LIMIT;
  }

  try {
    const events = deps.auditChainSync.queryInboundTail(since, limit);
    sendJson(res, 200, {
      ok: true,
      data: { events, count: events.length, since },
    });
    log.debug({ count: events.length, since, limit }, 'Federation: tail served');
  } catch (err) {
    log.error({ err: String(err) }, 'Federation: tail query failed');
    sendError(res, 500, 'Internal server error');
  }
}

function handlePeers(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FederationRoutesDeps,
  adminTokenBuf: Buffer | null,
): void {
  if (!isAdminAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized: invalid or missing admin bearer token');
    return;
  }
  const peers = deps.peerRegistry.getPeers().map(p => ({ name: p.name, url: p.url }));
  sendJson(res, 200, { ok: true, data: { peers } });
}

function handleStats(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FederationRoutesDeps,
  adminTokenBuf: Buffer | null,
): void {
  if (!isAdminAuthorised(req, adminTokenBuf)) {
    sendError(res, 401, 'Unauthorized: invalid or missing admin bearer token');
    return;
  }
  try {
    const outboundSeq = deps.auditChainSync.getOutboundSeq();
    const inboundEventCount = deps.auditChainSync.getInboundEventCount();
    const peersConfigured = deps.peerRegistry.getPeers().length;
    const lastInboundTs = deps.auditChainSync.getLastInboundTs();
    const lastOutboundTs = outboundSeq > 0 ? deps.auditChainSync.getLastOutboundTs() : null;

    sendJson(res, 200, {
      ok: true,
      data: {
        outboundSeq,
        inboundEventCount,
        peersConfigured,
        lastInboundTs,
        lastOutboundTs,
      },
    });
  } catch (err) {
    log.error({ err: String(err) }, 'Federation: stats failed');
    sendError(res, 500, 'Internal server error');
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Attach federation routes to the provided http.Server.
 *
 * @param server       - Existing http.Server (shared gateway).
 * @param deps         - PeerRegistry and AuditChainSync instances.
 * @param adminTokenBuf - Admin bearer token buffer (for /peers and /stats).
 */
export function registerFederationRoutes(
  server: HttpServer,
  deps: FederationRoutesDeps,
  adminTokenBuf: Buffer | null,
): void {
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? '';
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';

    if (!pathname.startsWith('/v1/federation/')) return;

    // POST /v1/federation/audit/ingest
    if (method === 'POST' && pathname === '/v1/federation/audit/ingest') {
      handleIngest(req, res, deps).catch((err: unknown) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Federation: unhandled error in ingest');
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      });
      return;
    }

    // GET /v1/federation/audit/tail
    if (method === 'GET' && pathname === '/v1/federation/audit/tail') {
      handleTail(req, res, deps);
      return;
    }

    // GET /v1/federation/public-key
    if (method === 'GET' && pathname === '/v1/federation/public-key') {
      handlePublicKey(req, res, deps);
      return;
    }

    // GET /v1/federation/peers
    if (method === 'GET' && pathname === '/v1/federation/peers') {
      handlePeers(req, res, deps, adminTokenBuf);
      return;
    }

    // GET /v1/federation/stats
    if (method === 'GET' && pathname === '/v1/federation/stats') {
      handleStats(req, res, deps, adminTokenBuf);
      return;
    }

    // Unmatched /v1/federation/* path — return silently so other handlers
    // (federation-error-routes.ts) can handle it without double-response.
    return;
  });

  log.info(
    'Federation routes registered (POST /v1/federation/audit/ingest, GET /v1/federation/audit/tail, GET /v1/federation/peers, GET /v1/federation/stats, GET /v1/federation/public-key)',
  );
}
