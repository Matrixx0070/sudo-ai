/**
 * @file signing.ts
 * @description Outbound webhook payload signing (Stripe-style scheme):
 *
 *   X-Sudo-Timestamp: <unix seconds>
 *   X-Sudo-Signature: v1=<hex hmac-sha256(secret, `${timestamp}.${rawBody}`)>
 *
 * During a secret-rotation grace window the header carries TWO comma-separated
 * `v1=` entries (current + previous secret) so receivers still holding the old
 * secret keep verifying until the grace expires. The timestamp binds the
 * signature to a moment in time — receivers reject stale timestamps to defeat
 * replay. `verifyEventSignature` is the reference receiver implementation
 * (used by our own tests and documented for SDK consumers).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Default receiver-side replay tolerance, seconds. */
export const DEFAULT_TOLERANCE_S = 300;

/** Generate a new endpoint signing secret (`whsec_` + 32 random bytes). */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Build the signature header value for a payload.
 * @param secrets one or more signing secrets (current first, then any
 *   still-in-grace previous secret) — one `v1=` entry per secret.
 */
export function signEvent(secrets: readonly string[], timestampS: number, rawBody: string): string {
  return secrets.map((s) => `v1=${hmacHex(s, `${timestampS}.${rawBody}`)}`).join(',');
}

export interface VerifyOptions {
  /** Max allowed |now - timestamp| in seconds; <=0 disables the check. */
  toleranceS?: number;
  /** Injectable clock (ms) for tests. */
  nowMs?: number;
}

/**
 * Reference receiver-side verification: recompute the HMAC and compare
 * (constant-time) against every `v1=` entry in the header.
 */
export function verifyEventSignature(
  secret: string,
  signatureHeader: string,
  timestampHeader: string,
  rawBody: string,
  opts: VerifyOptions = {},
): { ok: boolean; reason?: string } {
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  const tol = opts.toleranceS ?? DEFAULT_TOLERANCE_S;
  const nowS = (opts.nowMs ?? Date.now()) / 1000;
  if (tol > 0 && Math.abs(nowS - ts) > tol) return { ok: false, reason: 'timestamp outside tolerance (replay?)' };

  const expected = Buffer.from(hmacHex(secret, `${ts}.${rawBody}`), 'hex');
  const v1s = signatureHeader.split(',').map((p) => p.trim()).filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (v1s.length === 0) return { ok: false, reason: 'no v1 signature' };
  for (const v of v1s) {
    let got: Buffer;
    try { got = Buffer.from(v.trim().toLowerCase(), 'hex'); } catch { continue; }
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: 'signature mismatch' };
}
