import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  authenticateHttp,
  authenticateToken,
  hasScope,
  isLocalDirectRequest,
  isLoopbackAddress,
  unifiedAuthEnabled,
  type GatewayCredential,
} from '../../src/core/gateway/auth.js';

// Minimal IncomingMessage stub for auth decisions.
function mkReq(opts: {
  bearer?: string;
  remote?: string;
  headers?: Record<string, string>;
} = {}): IncomingMessage {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  return {
    headers,
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

const ENV_KEYS = [
  'GATEWAY_TOKEN',
  'GATEWAY_SECRET',
  'WEB_CHAT_TOKEN',
  'SUDO_GATEWAY_UNIFIED_AUTH',
] as const;

describe('gateway/auth', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('isLoopbackAddress', () => {
    it('recognises loopback forms and rejects others', () => {
      for (const a of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', '::ffff:127.0.0.1']) {
        expect(isLoopbackAddress(a)).toBe(true);
      }
      for (const a of ['10.0.0.5', '192.168.1.2', '8.8.8.8', undefined]) {
        expect(isLoopbackAddress(a)).toBe(false);
      }
    });
  });

  describe('isLocalDirectRequest', () => {
    it('is true for loopback with no forwarded headers', () => {
      expect(isLocalDirectRequest(mkReq({ remote: '127.0.0.1' }))).toBe(true);
    });
    it('is FALSE when any forwarded header is present, even on loopback', () => {
      expect(isLocalDirectRequest(mkReq({ remote: '127.0.0.1', headers: { 'x-forwarded-for': '8.8.8.8' } }))).toBe(false);
      expect(isLocalDirectRequest(mkReq({ remote: '127.0.0.1', headers: { forwarded: 'for=8.8.8.8' } }))).toBe(false);
      expect(isLocalDirectRequest(mkReq({ remote: '127.0.0.1', headers: { 'x-real-ip': '8.8.8.8' } }))).toBe(false);
    });
    it('is false for non-loopback', () => {
      expect(isLocalDirectRequest(mkReq({ remote: '10.0.0.5' }))).toBe(false);
    });
  });

  describe('hasScope (admin implies all)', () => {
    it('admin satisfies every scope', () => {
      const p = { scopes: ['operator.admin'] as const };
      expect(hasScope(p, 'operator.read')).toBe(true);
      expect(hasScope(p, 'operator.write')).toBe(true);
      expect(hasScope(p, 'operator.chat')).toBe(true);
    });
    it('narrow scopes only satisfy themselves', () => {
      const p = { scopes: ['operator.read', 'operator.chat'] as const };
      expect(hasScope(p, 'operator.read')).toBe(true);
      expect(hasScope(p, 'operator.chat')).toBe(true);
      expect(hasScope(p, 'operator.write')).toBe(false);
      expect(hasScope(p, 'operator.admin')).toBe(false);
    });
  });

  describe('authenticateHttp — unified mode (default)', () => {
    it('accepts a matching GATEWAY_TOKEN as admin owner', () => {
      process.env['GATEWAY_TOKEN'] = 'sekret';
      const p = authenticateHttp(mkReq({ bearer: 'sekret' }));
      expect(p.ok).toBe(true);
      expect(p.credential).toBe('gateway-token');
      expect(p.isOwner).toBe(true);
      expect(hasScope(p, 'operator.admin')).toBe(true);
    });

    it('rejects a wrong bearer when a token is configured', () => {
      process.env['GATEWAY_TOKEN'] = 'sekret';
      expect(authenticateHttp(mkReq({ bearer: 'nope' })).ok).toBe(false);
      expect(authenticateHttp(mkReq({})).ok).toBe(false); // no bearer at all
    });

    it('loopback-direct is authorised when NO secret is configured (dev convenience)', () => {
      const p = authenticateHttp(mkReq({ remote: '127.0.0.1' }));
      expect(p.ok).toBe(true);
      expect(p.credential).toBe('loopback');
      expect(p.isOwner).toBe(true);
    });

    it('SECURITY: no secret + forwarded header → DENY (closes the open hole)', () => {
      const p = authenticateHttp(mkReq({ remote: '127.0.0.1', headers: { 'x-forwarded-for': '8.8.8.8' } }));
      expect(p.ok).toBe(false);
      expect(p.reason).toBe('no-secret-and-not-local');
    });

    it('SECURITY: no secret + non-loopback → DENY', () => {
      expect(authenticateHttp(mkReq({ remote: '10.0.0.5' })).ok).toBe(false);
    });

    it('web-chat-token grants chat/read but not owner/admin', () => {
      process.env['WEB_CHAT_TOKEN'] = 'webtok';
      const accept: GatewayCredential[] = ['web-chat-token', 'loopback'];
      const p = authenticateHttp(mkReq({ bearer: 'webtok', remote: '10.0.0.5' }), { accept });
      expect(p.ok).toBe(true);
      expect(p.isOwner).toBe(false);
      expect(hasScope(p, 'operator.chat')).toBe(true);
      expect(hasScope(p, 'operator.read')).toBe(true);
      expect(hasScope(p, 'operator.admin')).toBe(false);
    });

    it('gateway-secret is only accepted when the surface opts in', () => {
      process.env['GATEWAY_SECRET'] = 'wssecret';
      // default accept (token+loopback) does NOT accept gateway-secret
      expect(authenticateHttp(mkReq({ bearer: 'wssecret', remote: '10.0.0.5' })).ok).toBe(false);
      // opt-in surface accepts it
      const p = authenticateHttp(mkReq({ bearer: 'wssecret', remote: '10.0.0.5' }), { accept: ['gateway-secret'] });
      expect(p.ok).toBe(true);
      expect(p.credential).toBe('gateway-secret');
    });
  });

  describe('authenticateHttp — legacy mode (SUDO_GATEWAY_UNIFIED_AUTH=0)', () => {
    beforeEach(() => {
      process.env['SUDO_GATEWAY_UNIFIED_AUTH'] = '0';
    });
    it('GW-3a: legacy-open ONLY for loopback-direct; proxied/non-loopback denied', () => {
      expect(unifiedAuthEnabled()).toBe(false);
      // proxied / non-loopback is now DENIED even under the kill-switch (hole closed)
      expect(authenticateHttp(mkReq({ remote: '8.8.8.8', headers: { 'x-forwarded-for': '1.2.3.4' } })).ok).toBe(false);
      // loopback-direct is still open (dev convenience)
      const local = authenticateHttp(mkReq({ remote: '127.0.0.1' }));
      expect(local.ok).toBe(true);
      expect(local.reason).toContain('legacy-open-loopback');
    });
    it('requires the token when GATEWAY_TOKEN is set (loopback-direct)', () => {
      process.env['GATEWAY_TOKEN'] = 'sekret';
      expect(authenticateHttp(mkReq({ remote: '127.0.0.1', bearer: 'sekret' })).ok).toBe(true);
      expect(authenticateHttp(mkReq({ remote: '127.0.0.1', bearer: 'nope' })).ok).toBe(false);
    });
  });

  describe('secretOverride (dependency-injected surfaces)', () => {
    it('uses the injected buffer, ignoring env GATEWAY_TOKEN', () => {
      const tok = Buffer.from('injected', 'utf8'); // env has no token; surface injects one
      expect(authenticateHttp(mkReq({ bearer: 'injected' }), { secretOverride: tok }).ok).toBe(true);
      expect(authenticateHttp(mkReq({ bearer: 'wrong' }), { secretOverride: tok }).ok).toBe(false);
      expect(authenticateHttp(mkReq({ remote: '127.0.0.1' }), { secretOverride: tok }).ok).toBe(false);
    });
    it('override=null → no secret → loopback dev ok, proxied fail-closed', () => {
      expect(authenticateHttp(mkReq({ remote: '127.0.0.1' }), { secretOverride: null }).ok).toBe(true);
      expect(authenticateHttp(mkReq({ remote: '127.0.0.1', headers: { 'x-forwarded-for': '8.8.8.8' } }), { secretOverride: null }).ok).toBe(false);
    });
    it('secretOverrideCredential routes the injected secret to gateway-secret (ws-server)', () => {
      const opts = {
        accept: ['gateway-secret', 'gateway-token', 'loopback'] as GatewayCredential[],
        legacySecretEnv: 'GATEWAY_SECRET',
        secretOverride: Buffer.from('wssecret', 'utf8'),
        secretOverrideCredential: 'gateway-secret' as const,
      };
      // injected ws secret matches → ok (non-loopback remote, so not a loopback pass)
      expect(authenticateToken('wssecret', mkReq({ remote: '10.0.0.5' }), opts).ok).toBe(true);
      expect(authenticateToken('wrong', mkReq({ remote: '10.0.0.5' }), opts).ok).toBe(false);
      // operator GATEWAY_TOKEN (from env) also works on the same surface → unified boundary
      process.env['GATEWAY_TOKEN'] = 'optok';
      expect(authenticateToken('optok', mkReq({ remote: '10.0.0.5' }), opts).ok).toBe(true);
    });
  });
});
