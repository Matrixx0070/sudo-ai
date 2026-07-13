/**
 * @file webhook-signatures.ts
 * @description Constant-time inbound-webhook authentication (Spec 4). One
 * verifier per scheme; all comparisons use timingSafeEqual on equal-length
 * buffers. A scheme other than 'none' with no configured secret fails closed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookHook } from './webhook-config.js';

export interface VerifyResult { ok: boolean; reason?: string }

/** Constant-time equality for two utf8 strings (length-guarded). */
function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Constant-time equality for two hex digests (length-guarded, case-insensitive). */
function eqHex(a: string, b: string): boolean {
  const aa = a.trim().toLowerCase();
  const bb = b.trim().toLowerCase();
  if (aa.length !== bb.length || aa.length === 0) return false;
  try { return timingSafeEqual(Buffer.from(aa, 'hex'), Buffer.from(bb, 'hex')); } catch { return false; }
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * Verify an inbound request against the hook's scheme.
 * @param rawBody the EXACT bytes received (signatures are over the raw body).
 */
export function verifySignature(
  hook: WebhookHook,
  secret: string | null,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): VerifyResult {
  if (hook.signature === 'none') return { ok: true };
  if (!secret) return { ok: false, reason: 'hook secret not configured' };

  switch (hook.signature) {
    case 'bearer': {
      const xhook = header(headers, 'x-hook-secret');
      const auth = header(headers, 'authorization');
      const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1] ?? '';
      const provided = xhook || bearer;
      if (!provided) return { ok: false, reason: 'missing X-Hook-Secret' };
      return eq(provided, secret) ? { ok: true } : { ok: false, reason: 'bad secret' };
    }
    case 'hmac': {
      const sig = header(headers, 'x-hook-signature').replace(/^sha256=/i, '');
      if (!sig) return { ok: false, reason: 'missing X-Hook-Signature' };
      return eqHex(sig, hmacHex(secret, rawBody)) ? { ok: true } : { ok: false, reason: 'bad signature' };
    }
    case 'github': {
      const sig = header(headers, 'x-hub-signature-256').replace(/^sha256=/i, '');
      if (!sig) return { ok: false, reason: 'missing X-Hub-Signature-256' };
      return eqHex(sig, hmacHex(secret, rawBody)) ? { ok: true } : { ok: false, reason: 'bad signature' };
    }
    case 'stripe': {
      const sh = header(headers, 'stripe-signature');
      if (!sh) return { ok: false, reason: 'missing Stripe-Signature' };
      // Parse "t=...,v1=...,v1=..." — any v1 matching the signed payload passes.
      const parts = sh.split(',').map((p) => p.trim());
      const t = parts.find((p) => p.startsWith('t='))?.slice(2) ?? '';
      const v1s = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
      if (!t || v1s.length === 0) return { ok: false, reason: 'malformed Stripe-Signature' };
      // Replay protection: reject a timestamp outside tolerance (default 300s;
      // SUDO_WEBHOOK_STRIPE_TOLERANCE_S, <=0 disables). Without this a captured
      // signature replays forever — and Stripe dedupe (body id) is best-effort.
      const tol = Number(process.env['SUDO_WEBHOOK_STRIPE_TOLERANCE_S'] ?? '300');
      const ts = Number(t);
      if (!Number.isFinite(ts)) return { ok: false, reason: 'bad Stripe timestamp' };
      if (tol > 0 && Math.abs(Date.now() / 1000 - ts) > tol) return { ok: false, reason: 'Stripe timestamp outside tolerance (replay?)' };
      const expected = hmacHex(secret, `${t}.${rawBody}`);
      return v1s.some((v) => eqHex(v, expected)) ? { ok: true } : { ok: false, reason: 'bad signature' };
    }
    default:
      return { ok: false, reason: 'unknown signature scheme' };
  }
}

/** Best-effort delivery id for dedupe, by scheme + common headers, else null. */
export function deliveryId(headers: Record<string, string | string[] | undefined>): string | null {
  return (
    header(headers, 'x-github-delivery') ||
    header(headers, 'x-hook-delivery') ||
    header(headers, 'idempotency-key') ||
    header(headers, 'x-request-id') ||
    null
  ) || null;
}

/**
 * Fallback delivery id from the body's top-level `id` — covers providers whose
 * event id is in the payload not a header (Stripe `evt_…`, and generic JSON).
 * Returns null when the body isn't JSON with a string id.
 */
export function bodyEventId(rawBody: string): string | null {
  try {
    const j = JSON.parse(rawBody) as { id?: unknown };
    return typeof j.id === 'string' && j.id.length > 0 ? j.id : null;
  } catch { return null; }
}
