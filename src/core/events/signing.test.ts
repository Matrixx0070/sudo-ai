import { describe, expect, it } from 'vitest';
import { newWebhookSecret, signEvent, verifyEventSignature } from './signing.js';

describe('webhook signing', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'message.completed', data: { a: 1 } });

  it('sign → verify roundtrip', () => {
    const secret = newWebhookSecret();
    const ts = Math.floor(Date.now() / 1000);
    const header = signEvent([secret], ts, body);
    expect(header).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyEventSignature(secret, header, String(ts), body).ok).toBe(true);
  });

  it('rejects tampered body and wrong secret', () => {
    const secret = newWebhookSecret();
    const ts = Math.floor(Date.now() / 1000);
    const header = signEvent([secret], ts, body);
    expect(verifyEventSignature(secret, header, String(ts), body + 'x').ok).toBe(false);
    expect(verifyEventSignature(newWebhookSecret(), header, String(ts), body).ok).toBe(false);
  });

  it('rejects stale timestamps (replay protection)', () => {
    const secret = newWebhookSecret();
    const ts = Math.floor(Date.now() / 1000) - 3600;
    const header = signEvent([secret], ts, body);
    const r = verifyEventSignature(secret, header, String(ts), body);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('tolerance');
    // Explicit tolerance override accepts it.
    expect(verifyEventSignature(secret, header, String(ts), body, { toleranceS: 0 }).ok).toBe(true);
  });

  it('rotation grace: header signed with [new, old] verifies against either', () => {
    const oldSecret = newWebhookSecret();
    const newSecret = newWebhookSecret();
    const ts = Math.floor(Date.now() / 1000);
    const header = signEvent([newSecret, oldSecret], ts, body);
    expect(header.split(',')).toHaveLength(2);
    expect(verifyEventSignature(oldSecret, header, String(ts), body).ok).toBe(true);
    expect(verifyEventSignature(newSecret, header, String(ts), body).ok).toBe(true);
  });

  it('malformed inputs fail closed', () => {
    const secret = newWebhookSecret();
    expect(verifyEventSignature(secret, '', '123', body).ok).toBe(false);
    expect(verifyEventSignature(secret, 'v1=zz', 'nan', body).ok).toBe(false);
  });
});
