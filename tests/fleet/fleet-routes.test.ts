/**
 * @file tests/fleet/fleet-routes.test.ts
 * @description Gap #28c slice 1 — HTTP integration: real signed register
 * POST + admin list GET through the dashboard dispatcher.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DashboardServer,
  registerDashboardGlobals,
} from '../../src/core/dashboard/dashboard-server.js';
import { registerRoutes } from '../../src/core/dashboard/dashboard-routes.js';
import type { DashboardConfig } from '../../src/core/dashboard/dashboard-types.js';
import { createDeviceIdentity, defaultIdentityPath } from '../../src/core/fleet/device-identity.js';
import { canonicalizePayload, type RegistrationPayload } from '../../src/core/fleet/registration.js';
import { RegistryStore } from '../../src/core/fleet/registry-store.js';

let tmp: string;
let store: RegistryStore;

interface TestServer { baseUrl: string; close(): Promise<void> }
function startTestServer(cfg?: Partial<DashboardConfig> & { adminPowers?: boolean }): Promise<TestServer> {
  // adminPowersEnabled() reads process.env.SUDO_ADMIN_POWERS directly —
  // set/clear it for the duration of this test server.
  if (cfg?.adminPowers === false) delete process.env['SUDO_ADMIN_POWERS'];
  else process.env['SUDO_ADMIN_POWERS'] = '1';
  const { adminPowers: _unused, ...rest } = cfg ?? {};
  const full: DashboardConfig = {
    port: 0,
    authToken: 'fleet-bearer',
    refreshIntervalMs: 30000,
    loopbackTrust: false,
    ...rest,
  };
  return new Promise((resolve, reject) => {
    const server = new DashboardServer(full);
    const httpServer = http.createServer((req, res) => {
      Promise.resolve(registerRoutes(req, res, server, full)).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'test_dispatch_error', message: String(err) }));
        }
      });
    });
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as import('node:net').AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r, j) => httpServer.close((e) => (e ? j(e) : r()))),
      });
    });
    httpServer.on('error', reject);
  });
}

interface RawResponse { status: number; body: string }
function rawRequest(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (bodyStr !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method: opts.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

function clearGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  delete g['__sudoBrain'];
  delete g['__sudoGateway'];
  delete g['__sudoAlignment'];
  delete g['__sudoAgentSwarm'];
  delete g['__sudoUpdater'];
  delete g['__sudoAudit'];
  delete g['__sudoAuthBackend'];
  delete g['__sudoFleetRegistrar'];
}

beforeEach(() => {
  clearGlobals();
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-fleet-routes-'));
  store = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db') });
});
afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
  clearGlobals();
});

describe('POST /api/fleet/register (#28c slice 1)', () => {
  it('FR-01: registrar mode OFF → 503 with fleet_registrar_not_enabled', async () => {
    // No registerDashboardGlobals with fleetRegistrar.
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body: { payload: {}, signature: '' } });
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).error).toBe('fleet_registrar_not_enabled');
    } finally { await srv.close(); }
  });

  it('FR-02: valid signed payload → 200 + row in store', async () => {
    registerDashboardGlobals({ fleetRegistrar: store });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const payload: RegistrationPayload = {
      version: 1,
      deviceId: id.deviceId,
      publicKeyPem: id.publicKeyPem,
      hostname: 'dev-host',
      version_str: '4.1.0',
      ts: Date.now(),
      metadata: { region: 'eu' },
    };
    const signature = id.sign(canonicalizePayload(payload));
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body: { payload, signature } });
      expect(r.status).toBe(200);
      const json = JSON.parse(r.body);
      expect(json.ok).toBe(true);
      expect(json.deviceId).toBe(id.deviceId);
      // Row visible via the store directly.
      const row = store.get(id.deviceId);
      expect(row?.hostname).toBe('dev-host');
    } finally { await srv.close(); }
  });

  it('FR-03: bad signature → 400 invalid_registration / bad_signature', async () => {
    registerDashboardGlobals({ fleetRegistrar: store });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const payload: RegistrationPayload = {
      version: 1,
      deviceId: id.deviceId,
      publicKeyPem: id.publicKeyPem,
      hostname: 'dev-host',
      version_str: '4.1.0',
      ts: Date.now(),
    };
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body: { payload, signature: 'AAAA' } });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body).reason).toBe('bad_signature');
    } finally { await srv.close(); }
  });

  it('FR-04: register is PUBLIC — no Bearer required even with auth enforced', async () => {
    registerDashboardGlobals({ fleetRegistrar: store });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const payload: RegistrationPayload = {
      version: 1,
      deviceId: id.deviceId,
      publicKeyPem: id.publicKeyPem,
      hostname: 'h',
      version_str: '4.1.0',
      ts: Date.now(),
    };
    const signature = id.sign(canonicalizePayload(payload));
    // No Authorization header — proves the route bypasses Bearer gate.
    const srv = await startTestServer({ loopbackTrust: false });
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body: { payload, signature } });
      expect(r.status).toBe(200);
    } finally { await srv.close(); }
  });

  it('FR-05: malformed JSON body → 400', async () => {
    registerDashboardGlobals({ fleetRegistrar: store });
    const srv = await startTestServer();
    try {
      // Raw write of non-JSON.
      const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const parsed = new URL(`${srv.baseUrl}/api/fleet/register`);
        const req = http.request({
          hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': '5' },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.write('not{j');
        req.end();
      });
      expect(raw.status).toBe(400);
    } finally { await srv.close(); }
  });
});

describe('GET /api/admin/fleet/devices (#28c slice 1)', () => {
  it('FR-06: registrar mode OFF → 503 fleet_registrar_not_enabled', async () => {
    const srv = await startTestServer({ loopbackTrust: true });
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices`);
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).error).toBe('fleet_registrar_not_enabled');
    } finally { await srv.close(); }
  });

  it('FR-07: requires admin powers (503 when SUDO_ADMIN_POWERS=0)', async () => {
    registerDashboardGlobals({ fleetRegistrar: store });
    const srv = await startTestServer({ loopbackTrust: true, adminPowers: false });
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices`);
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).error).toBe('admin_powers_disabled');
    } finally { await srv.close(); process.env['SUDO_ADMIN_POWERS'] = '1'; }
  });

  it('FR-08: requires Bearer without loopback-trust', async () => {
    registerDashboardGlobals({ fleetRegistrar: store });
    const srv = await startTestServer({ loopbackTrust: false });
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices`);
      expect(r.status).toBe(401);
    } finally { await srv.close(); }
  });

  it('FR-09: returns registered devices with PUBLIC KEY REDACTED (fingerprint only)', async () => {
    registerDashboardGlobals({ fleetRegistrar: store });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    store.upsert({
      deviceId: id.deviceId,
      publicKeyPem: id.publicKeyPem,
      hostname: 'dev-1',
      versionStr: '4.1.0',
      metadata: { region: 'us' },
    });
    const srv = await startTestServer({ loopbackTrust: true });
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices`);
      expect(r.status).toBe(200);
      const json = JSON.parse(r.body);
      expect(json.count).toBe(1);
      expect(json.devices[0].deviceId).toBe(id.deviceId);
      expect(json.devices[0].hostname).toBe('dev-1');
      expect(json.devices[0].publicKeyFingerprint).toMatch(/^[0-9a-f]{16}$/);
      // Key MUST NOT leak — only the fingerprint.
      expect(json.devices[0].publicKeyPem).toBeUndefined();
      expect(json.devices[0].metadata).toEqual({ region: 'us' });
    } finally { await srv.close(); }
  });

  it('FR-10: admin list honors ?limit=', async () => {
    registerDashboardGlobals({ fleetRegistrar: store });
    for (let i = 0; i < 5; i++) {
      store.upsert({
        deviceId: `aaaa${i}`.padEnd(16, '0'),
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n',
        hostname: `h${i}`,
        versionStr: '4.1.0',
      });
    }
    const srv = await startTestServer({ loopbackTrust: true });
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices?limit=2`);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).count).toBe(2);
    } finally { await srv.close(); }
  });
});

describe('end-to-end: device → registrar → admin list', () => {
  it('FR-11: full round-trip with two real devices', async () => {
    registerDashboardGlobals({ fleetRegistrar: store });
    const id1 = createDeviceIdentity(path.join(tmp, 'id1.json'));
    const id2 = createDeviceIdentity(path.join(tmp, 'id2.json'));

    async function registerOne(idLocal: ReturnType<typeof createDeviceIdentity>, hostname: string, srv: TestServer): Promise<void> {
      const payload: RegistrationPayload = {
        version: 1,
        deviceId: idLocal.deviceId,
        publicKeyPem: idLocal.publicKeyPem,
        hostname,
        version_str: '4.1.0',
        ts: Date.now(),
      };
      const signature = idLocal.sign(canonicalizePayload(payload));
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body: { payload, signature } });
      expect(r.status).toBe(200);
    }

    const srv = await startTestServer({ loopbackTrust: true });
    try {
      await registerOne(id1, 'edge-A', srv);
      await registerOne(id2, 'edge-B', srv);
      const list = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices`);
      expect(list.status).toBe(200);
      const ids = (JSON.parse(list.body).devices as Array<{ deviceId: string }>).map((d) => d.deviceId).sort();
      expect(ids).toEqual([id1.deviceId, id2.deviceId].sort());
    } finally { await srv.close(); }
  });
});
