/**
 * @file tests/gateway/gw4-single-listener.test.ts
 * @description GW-4 — single-listener default + admin auth unification.
 *   - initDashboard({ standalone:false }) suppresses the second listener; the
 *     default opens one (rollback path).
 *   - adminRouter.dispatch no longer self-auths (the bespoke Bearer check was
 *     removed; auth is enforced upstream at the gateway boundary).
 *   - registerAdminApi stays fail-closed when no admin token is configured.
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

function fakeReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
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
