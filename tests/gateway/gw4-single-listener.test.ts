/**
 * @file tests/gateway/gw4-single-listener.test.ts
 * @description GW-4 — single-listener default + admin auth unification.
 *   - initDashboard({ standalone:false }) suppresses the second listener; the
 *     default opens one (rollback path).
 *   - adminRouter.dispatch no longer self-auths (the bespoke Bearer check was
 *     removed; auth is enforced upstream at the gateway boundary).
 *   - registerAdminApi stays fail-closed when no admin token is configured.
 *   - registerAdminApi's mounted request handler enforces the 401-on-remote gate
 *     and accepts the effective mount token (HIGH-1/HIGH-2).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { initDashboard, shutdownDashboard, getDashboard } from '../../src/core/dashboard/dashboard-server.js';
import { adminRouter } from '../../src/core/api/admin-router.js';
import { registerAdminApi } from '../../src/core/api/admin/register.js';

const baseCfg = { authToken: 't', refreshIntervalMs: 5000, bindAddress: '127.0.0.1' as const };

describe('GW-4 dashboard single-listener default', () => {
  afterEach(() => shutdownDashboard());

  it('standalone:false suppresses the standalone listener', () => {
    const d = initDashboard({ ...baseCfg, port: 0, standalone: false });
    expect(d.isListening()).toBe(false);
    // Instance is still registered so it can be mounted on the gateway port.
    expect(getDashboard()).toBe(d);
  });

  it('default (standalone omitted) opens the listener for rollback', async () => {
    const d = initDashboard({ ...baseCfg, port: 0 });
    expect(d.isListening()).toBe(true);
  });
});

// A minimal ServerResponse double capturing the status code.
function fakeRes(): { res: ServerResponse; status: () => number | null } {
  let status: number | null = null;
  const res = {
    headersSent: false,
    setHeader: () => {},
    writeHead: (code: number) => { status = code; return res; },
    end: () => { (res as { headersSent: boolean }).headersSent = true; },
  } as unknown as ServerResponse;
  return { res, status: () => status };
}

function fakeReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  return { method, url, headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('GW-4 admin-router: bespoke Bearer check removed', () => {
  const saved = process.env['SUDO_AI_DASHBOARD_TOKEN'];
  beforeEach(() => { process.env['SUDO_AI_DASHBOARD_TOKEN'] = 'a-token'; });
  afterEach(() => {
    if (saved === undefined) delete process.env['SUDO_AI_DASHBOARD_TOKEN'];
    else process.env['SUDO_AI_DASHBOARD_TOKEN'] = saved;
  });

  it('dispatch no longer 401s an unauthenticated call (auth is upstream now)', async () => {
    const { res, status } = fakeRes();
    // No Authorization header, yet SUDO_AI_DASHBOARD_TOKEN is set: pre-GW-4 this
    // returned 401 from inside dispatch. Now it must reach route matching.
    const handled = await adminRouter.dispatch(fakeReq('GET', '/api/admin/does-not-exist'), res);
    expect(handled).toBe(false);       // no route matched → fell through
    expect(status()).not.toBe(401);    // NOT rejected by a bespoke auth check
  });
});

describe('GW-4 registerAdminApi fail-closed', () => {
  const savedApi = process.env['SUDO_ADMIN_API'];
  const savedTok = process.env['SUDO_AI_DASHBOARD_TOKEN'];
  const savedGw = process.env['GATEWAY_TOKEN'];
  afterEach(() => {
    for (const [k, v] of [['SUDO_ADMIN_API', savedApi], ['SUDO_AI_DASHBOARD_TOKEN', savedTok], ['GATEWAY_TOKEN', savedGw]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('refuses to mount when no admin token is configured', async () => {
    process.env['SUDO_ADMIN_API'] = '1';
    delete process.env['SUDO_AI_DASHBOARD_TOKEN'];
    delete process.env['GATEWAY_TOKEN'];
    const fakeServer = { on: () => {} } as unknown as import('node:http').Server;
    const mounted = await registerAdminApi(fakeServer);
    expect(mounted).toBe(false);
  });

  it('does not mount when the flag is off', async () => {
    delete process.env['SUDO_ADMIN_API'];
    const fakeServer = { on: () => {} } as unknown as import('node:http').Server;
    expect(await registerAdminApi(fakeServer)).toBe(false);
  });
});

/**
 * HIGH-2: the mounted request handler is the core GW-4 security gate — a remote
 * request with no (or wrong) credential must 401, and the effective mount token
 * (SUDO_AI_DASHBOARD_TOKEN, HIGH-1) must actually authorize. The prior suite only
 * ever exercised loopback with no assertion on the denial path.
 */
describe('GW-4 registerAdminApi mounted auth gate (HIGH-1/HIGH-2)', () => {
  const savedApi = process.env['SUDO_ADMIN_API'];
  const savedTok = process.env['SUDO_AI_DASHBOARD_TOKEN'];
  const savedGw = process.env['GATEWAY_TOKEN'];
  const savedUnified = process.env['SUDO_GATEWAY_UNIFIED_AUTH'];

  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;

  beforeEach(async () => {
    process.env['SUDO_ADMIN_API'] = '1';
    process.env['SUDO_AI_DASHBOARD_TOKEN'] = 'dash-secret';
    delete process.env['GATEWAY_TOKEN'];              // ONLY the dashboard token is set
    delete process.env['SUDO_GATEWAY_UNIFIED_AUTH'];  // unified auth ON (default)
    handler = undefined;
    const fakeServer = {
      on: (evt: string, cb: (req: IncomingMessage, res: ServerResponse) => void) => {
        if (evt === 'request') handler = cb;
      },
    } as unknown as import('node:http').Server;
    const mounted = await registerAdminApi(fakeServer);
    expect(mounted).toBe(true);
    expect(handler).toBeTypeOf('function');
  });

  afterEach(() => {
    for (const [k, v] of [
      ['SUDO_ADMIN_API', savedApi],
      ['SUDO_AI_DASHBOARD_TOKEN', savedTok],
      ['GATEWAY_TOKEN', savedGw],
      ['SUDO_GATEWAY_UNIFIED_AUTH', savedUnified],
    ] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  function call(req: IncomingMessage): () => number | null {
    const { res, status } = fakeRes();
    handler!(req, res);
    return status;
  }

  it('(a) non-loopback remote with NO credential → 401', () => {
    const status = call(fakeReq('GET', '/v1/admin/service/status', {}, '203.0.113.9'));
    expect(status()).toBe(401);
  });

  it('(b) forwarded proxy headers + NO credential → 401 (untrusted proxy)', () => {
    const status = call(
      fakeReq('GET', '/v1/admin/service/status', { 'x-forwarded-for': '10.0.0.1' }, '203.0.113.9'),
    );
    expect(status()).toBe(401);
  });

  it('fail-closed: even loopback with NO credential is denied once a token is set', () => {
    const status = call(fakeReq('GET', '/v1/admin/service/status', {}, '127.0.0.1'));
    expect(status()).toBe(401);
  });

  it('(c) remote with the correct dashboard token → authorized (not 401)', async () => {
    const status = call(
      fakeReq('GET', '/v1/admin/service/no-such-route', { authorization: 'Bearer dash-secret' }, '203.0.113.9'),
    );
    // dispatch is async; let the promise settle before asserting the status.
    await new Promise((r) => setTimeout(r, 25));
    expect(status()).not.toBe(401);
    expect(status()).toBe(404); // authed → route matching → no such route
  });

  it('legacy /api/admin/* 308-redirects to canonical /v1/admin/* (before auth)', () => {
    const { res, status } = fakeRes();
    const req = fakeReq('GET', '/api/admin/service/status', {}, '203.0.113.9');
    handler!(req, res);
    expect(status()).toBe(308); // redirected to canonical /v1/admin/* BEFORE any auth
  });

  it('a wrong token is rejected with 401', () => {
    const status = call(
      fakeReq('GET', '/v1/admin/service/status', { authorization: 'Bearer WRONG' }, '203.0.113.9'),
    );
    expect(status()).toBe(401);
  });
});
