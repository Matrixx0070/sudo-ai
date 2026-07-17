/**
 * @file gdrive/push.ts
 * @description F21 — push-notification plumbing (Apps Script fallback path).
 *
 * Transport (b) from the spec: a Google Apps Script on a 1-minute time
 * trigger checks watched surfaces and POSTs an HMAC-signed ping; the harness
 * verifies the signature and runs the matching job immediately. Polling
 * remains the backstop at its normal cadence.
 *
 * This module is the harness half: signature verification + kind->job
 * dispatch. Route wiring uses the EXISTING inbound-webhook gateway (Spec 4,
 * /v1/hooks/:hookId with hmac auth) — see docs/gdrive-apps-script.md for the
 * Script source + hook config. Native changes.watch channels (transport a)
 * need public HTTPS + domain verification and are deliberately not built.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('gdrive:push');

export type PushKind = 'inbox' | 'control-panel' | 'comments' | 'heartbeat-check';

const KIND_TO_EVENT: Record<PushKind, string> = {
  inbox: 'gdrive:inbox',
  'control-panel': 'gdrive:control-panel',
  comments: 'gdrive:comments',
  'heartbeat-check': 'gdrive:heartbeat',
};

export interface PushPing {
  kind: PushKind;
  /** Unix ms at the Script; rejected when older than the tolerance. */
  ts: number;
}

export const PING_TOLERANCE_MS = 5 * 60 * 1000;

export function signPing(ping: PushPing, secret: string): string {
  return createHmac('sha256', secret).update(`${ping.kind}:${ping.ts}`).digest('hex');
}

/** Verify an HMAC-signed ping (timing-safe; freshness-checked). */
export function verifyPing(
  ping: PushPing,
  signature: string,
  secret: string,
  now: number = Date.now(),
): boolean {
  if (!ping || !KIND_TO_EVENT[ping.kind] || typeof ping.ts !== 'number') return false;
  if (Math.abs(now - ping.ts) > PING_TOLERANCE_MS) return false;
  const expected = signPing(ping, secret);
  const a = Buffer.from(expected, 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Dispatch a verified ping to the matching job immediately. The runner is
 * injected (cli.ts passes a closure over its cron event dispatch) so this
 * module stays free of job imports.
 */
export async function handlePushPing(
  ping: PushPing,
  signature: string,
  secret: string,
  runEvent: (event: string) => Promise<void>,
): Promise<{ ok: boolean; reason?: string }> {
  if (!secret) return { ok: false, reason: 'no secret configured' };
  if (!verifyPing(ping, signature, secret)) {
    log.warn({ kind: ping?.kind }, 'REJECTED forged/stale gdrive push ping');
    return { ok: false, reason: 'bad signature or stale' };
  }
  await runEvent(KIND_TO_EVENT[ping.kind]);
  return { ok: true };
}
