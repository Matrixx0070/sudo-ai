/**
 * @file gateway/federation-error-helpers.ts
 * @description Utility helpers for federation error routes.
 *
 * Wave 2 — Federation Error Protocol.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_BODY = 64 * 1024; // 64 KB body cap
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
export const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute sliding window
export const RATE_LIMIT_MAX = 10; // 10 requests per minute per peer

// ---------------------------------------------------------------------------
// Rate limiter state (in-memory Map)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const MAX_RATE_LIMIT_ENTRIES = 1000;
let rateLimitCallCount = 0;

/**
 * Clear rate limit state (exported for testing only).
 */
export function clearRateLimitMap(): void {
  rateLimitMap.clear();
  rateLimitCallCount = 0;
}

/**
 * Cleanup old entries from rate limit map to prevent memory leak.
 * Removes entries where the window has expired beyond 2x window duration.
 */
function cleanupRateLimitMap(): void {
  const now = Date.now();
  const expiryThreshold = RATE_LIMIT_WINDOW_MS * 2;

  for (const [peerId, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart > expiryThreshold) {
      rateLimitMap.delete(peerId);
    }
  }
}

/**
 * Evict oldest entries when map exceeds maximum size.
 */
function evictOldestEntries(): void {
  if (rateLimitMap.size <= MAX_RATE_LIMIT_ENTRIES) return;

  // Convert to array and sort by windowStart (oldest first)
  const entries = Array.from(rateLimitMap.entries()).sort(
    (a, b) => a[1].windowStart - b[1].windowStart
  );

  // Remove oldest 10% of entries
  const toRemove = Math.max(1, Math.floor(entries.length * 0.1));
  for (let i = 0; i < toRemove; i++) {
    rateLimitMap.delete(entries[i][0]);
  }
}

export function checkRateLimit(peerId: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(peerId);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    // New window
    rateLimitMap.set(peerId, { count: 1, windowStart: now });
  } else {
    if (entry.count >= RATE_LIMIT_MAX) {
      const retryAfter = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
      return { allowed: false, retryAfter };
    }
    entry.count++;
  }

  // Periodic cleanup to prevent memory leak
  rateLimitCallCount++;
  if (rateLimitCallCount % 100 === 0) {
    cleanupRateLimitMap();
  }
  if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    evictOldestEntries();
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { ok: false, error: message });
}

export function extractBearer(req: IncomingMessage): string {
  const h = req.headers['authorization'] ?? '';
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] ?? '') : '';
}

export function isAdminAuthorised(req: IncomingMessage, adminTokenBuf: Buffer | null): boolean {
  if (adminTokenBuf === null) return true;
  const candidate = Buffer.from(extractBearer(req), 'utf8');
  return candidate.length === adminTokenBuf.length && timingSafeEqual(candidate, adminTokenBuf);
}

/**
 * Check Content-Length header before reading body.
 * Returns true if body size is acceptable, false if too large.
 */
export function checkContentLength(req: IncomingMessage): boolean {
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    const size = parseInt(contentLength, 10);
    if (Number.isFinite(size) && size > MAX_BODY) {
      return false;
    }
  }
  return true;
}

export async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
