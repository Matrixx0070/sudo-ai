/**
 * Inbound webhook signature verification (Spec 4) — constant-time, per scheme.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySignature, deliveryId, bodyEventId } from '../../src/core/gateway/webhook-signatures.js';
import type { WebhookHook } from '../../src/core/gateway/webhook-config.js';

const base = { id: 'h', prompt: 'p', tools: [], mode: 'sync' as const, rateLimitPerMin: 60 };
const hook = (signature: WebhookHook['signature']): WebhookHook => ({ ...base, signature });
const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(body, 'utf8').digest('hex');
const S = 'topsecret';
const BODY = '{"hello":"world"}';

describe('verifySignature', () => {
  it('none → always ok', () => {
    expect(verifySignature(hook('none'), null, BODY, {}).ok).toBe(true);
  });

  it('any scheme with no secret configured → fails closed', () => {
    expect(verifySignature(hook('bearer'), null, BODY, { 'x-hook-secret': S }).ok).toBe(false);
  });

  it('bearer: X-Hook-Secret match / mismatch', () => {
    expect(verifySignature(hook('bearer'), S, BODY, { 'x-hook-secret': S }).ok).toBe(true);
    expect(verifySignature(hook('bearer'), S, BODY, { authorization: `Bearer ${S}` }).ok).toBe(true);
    expect(verifySignature(hook('bearer'), S, BODY, { 'x-hook-secret': 'nope' }).ok).toBe(false);
    expect(verifySignature(hook('bearer'), S, BODY, {}).ok).toBe(false);
  });

  it('hmac: X-Hook-Signature hex (with/without sha256= prefix)', () => {
    const sig = hmac(S, BODY);
    expect(verifySignature(hook('hmac'), S, BODY, { 'x-hook-signature': sig }).ok).toBe(true);
    expect(verifySignature(hook('hmac'), S, BODY, { 'x-hook-signature': `sha256=${sig}` }).ok).toBe(true);
    expect(verifySignature(hook('hmac'), S, BODY, { 'x-hook-signature': hmac(S, 'tampered') }).ok).toBe(false);
  });

  it('github: X-Hub-Signature-256', () => {
    const sig = `sha256=${hmac(S, BODY)}`;
    expect(verifySignature(hook('github'), S, BODY, { 'x-hub-signature-256': sig }).ok).toBe(true);
    expect(verifySignature(hook('github'), S, BODY, { 'x-hub-signature-256': 'sha256=deadbeef' }).ok).toBe(false);
    expect(verifySignature(hook('github'), S, BODY, {}).ok).toBe(false);
  });

  it('stripe: t=…,v1=… over `t.body` (fresh timestamp)', () => {
    const t = String(Math.floor(Date.now() / 1000));
    const v1 = hmac(S, `${t}.${BODY}`);
    expect(verifySignature(hook('stripe'), S, BODY, { 'stripe-signature': `t=${t},v1=${v1}` }).ok).toBe(true);
    expect(verifySignature(hook('stripe'), S, BODY, { 'stripe-signature': `t=${t},v1=deadbeef` }).ok).toBe(false);
    expect(verifySignature(hook('stripe'), S, BODY, { 'stripe-signature': 'garbage' }).ok).toBe(false);
  });

  it('stripe: rejects a stale timestamp even with a valid v1 (replay protection)', () => {
    const t = '1700000000'; // Nov 2023 — far outside the 300s tolerance
    const v1 = hmac(S, `${t}.${BODY}`);
    const r = verifySignature(hook('stripe'), S, BODY, { 'stripe-signature': `t=${t},v1=${v1}` });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tolerance|replay/i);
  });

  it('deliveryId prefers common headers; bodyEventId reads the body id (Stripe)', () => {
    expect(deliveryId({ 'x-github-delivery': 'abc' })).toBe('abc');
    expect(deliveryId({ 'idempotency-key': 'k1' })).toBe('k1');
    expect(deliveryId({})).toBeNull();
    expect(bodyEventId('{"id":"evt_123","type":"charge.succeeded"}')).toBe('evt_123');
    expect(bodyEventId('not json')).toBeNull();
    expect(bodyEventId('{"no":"id"}')).toBeNull();
  });
});
