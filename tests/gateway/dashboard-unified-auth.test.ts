import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { createUnifiedAuthBackend } from '../../src/core/dashboard/dashboard-server.js';

function mkReq(o: {
  bearer?: string;
  query?: string;
  remote?: string;
  headers?: Record<string, string>;
} = {}): IncomingMessage {
  const headers: Record<string, string> = { host: '127.0.0.1', ...(o.headers ?? {}) };
  if (o.bearer) headers['authorization'] = `Bearer ${o.bearer}`;
  return {
    headers,
    url: o.query ? `/?token=${o.query}` : '/',
    socket: { remoteAddress: o.remote ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

describe('dashboard unified auth backend (Slice D)', () => {
  const keys = ['GATEWAY_TOKEN', 'SUDO_GATEWAY_UNIFIED_AUTH'] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  it('accepts the operator GATEWAY_TOKEN via bearer, rejects wrong', () => {
    process.env['GATEWAY_TOKEN'] = 'gw';
    const b = createUnifiedAuthBackend();
    const ok = b.authenticate(mkReq({ bearer: 'gw' }), { allowQueryToken: false });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.principal).toBe('operator:gateway-token');
    expect(b.authenticate(mkReq({ bearer: 'nope' }), { allowQueryToken: false }).ok).toBe(false);
  });

  it('accepts GATEWAY_TOKEN via ?token= only when allowQueryToken', () => {
    process.env['GATEWAY_TOKEN'] = 'gw';
    const b = createUnifiedAuthBackend();
    expect(b.authenticate(mkReq({ query: 'gw' }), { allowQueryToken: true }).ok).toBe(true);
    expect(b.authenticate(mkReq({ query: 'gw' }), { allowQueryToken: false }).ok).toBe(false);
  });

  it('accepts the dashboard fallback token for back-compat', () => {
    process.env['GATEWAY_TOKEN'] = 'gw';
    const b = createUnifiedAuthBackend('dashtok');
    const r = b.authenticate(mkReq({ bearer: 'dashtok' }), { allowQueryToken: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.principal).toBe('dashboard:token');
    // wrong token, no gateway match → deny
    expect(b.authenticate(mkReq({ bearer: 'wrong' }), { allowQueryToken: false }).ok).toBe(false);
  });

  it('loopback-dev when no secret configured; proxied is fail-closed', () => {
    const b = createUnifiedAuthBackend();
    expect(b.authenticate(mkReq({ remote: '127.0.0.1' }), { allowQueryToken: false }).ok).toBe(true);
    expect(
      b.authenticate(mkReq({ remote: '127.0.0.1', headers: { 'x-forwarded-for': '8.8.8.8' } }), { allowQueryToken: false }).ok,
    ).toBe(false);
  });
});
