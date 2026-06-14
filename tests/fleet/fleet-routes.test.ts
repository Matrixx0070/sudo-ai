/**
 * @file tests/fleet/fleet-routes.test.ts
 * @description Gap #28c — HTTP integration of the register + admin device
 * list routes. Updated for slice 4: the register POST now requires a
 * single-use nonce from `GET /api/fleet/challenge`, and the admin list
 * surfaces `lastSeenAt` + `admissionStatus`.
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
import { createDeviceIdentity, defaultIdentityPath, type DeviceIdentity } from '../../src/core/fleet/device-identity.js';
import { canonicalizePayload, type RegistrationPayload } from '../../src/core/fleet/registration.js';
import { RegistryStore } from '../../src/core/fleet/registry-store.js';
import { NonceStore } from '../../src/core/fleet/nonce-store.js';

let tmp: string;
let store: RegistryStore;
let nonceStore: NonceStore;

interface TestServer { baseUrl: string; close(): Promise<void>; dashboardServer: DashboardServer }
function startTestServer(config?: DashboardConfig): Promise<TestServer> {
  const cfg: DashboardConfig = config ?? {
    port: 0,
    authToken: 'fleet-bearer',
    refreshIntervalMs: 30000,
    loopbackTrust: true,
  };
  return new Promise((resolve, reject) => {
    const server = new DashboardServer(cfg);
    const httpServer = http.createServer((req, res) => {
      Promise.resolve(registerRoutes(req, res, server, cfg)).catch((err) => {
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
        close: (): Promise<void> => new Promise((r, j) => httpServer.close((err) => (err ? j(err) : r()))),
        dashboardServer: server,
      });
    });
    httpServer.on('error', reject);
  });
}

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }
function rawRequest(url: string, opts: {
  method?: string;
  token?: string;
  body?: unknown;
  hostHeader?: string;
  extraHeaders?: Record<string, string>;
} = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (bodyStr !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    if (opts.hostHeader !== undefined) headers.Host = opts.hostHeader;
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method: opts.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })); },
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

function clearGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of ['__sudoBrain','__sudoGateway','__sudoAlignment','__sudoAgentSwarm','__sudoUpdater','__sudoAudit','__sudoAuthBackend','__sudoFleetRegistrar','__sudoFleetCommandQueue','__sudoFleetNonceStore']) delete g[k];
}

/** Build a signed v2 registration body, fetching a nonce from the live server. */
async function buildSignedRegistration(opts: {
  baseUrl: string;
  identity: DeviceIdentity;
  hostname?: string;
  metadata?: Record<string, string>;
}): Promise<{ payload: RegistrationPayload; signature: string }> {
  const challenge = await rawRequest(`${opts.baseUrl}/api/fleet/challenge?deviceId=${encodeURIComponent(opts.identity.deviceId)}`);
  if (challenge.status !== 200) throw new Error(`challenge ${challenge.status}`);
  const nonce = JSON.parse(challenge.body).nonce as string;
  const payload: RegistrationPayload = {
    version: 2,
    deviceId: opts.identity.deviceId,
    publicKeyPem: opts.identity.publicKeyPem,
    hostname: opts.hostname ?? 'dev-host',
    version_str: '4.1.0',
    ts: Date.now(),
    nonce,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  };
  return { payload, signature: opts.identity.sign(canonicalizePayload(payload)) };
}

beforeEach(() => {
  clearGlobals();
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-fleet-routes-'));
  store = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db') });
  nonceStore = new NonceStore();
});
afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
  clearGlobals();
});

describe('POST /api/fleet/register (#28c slice 1, slice 4 nonce-hardened)', () => {
  it('FR-01: registrar mode OFF → 503 with fleet_registrar_not_enabled', async () => {
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body: { payload: {}, signature: '' } });
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).error).toBe('fleet_registrar_not_enabled');
    } finally { await srv.close(); }
  });

  it('FR-02: valid signed payload (with nonce) → 200 + row in store', async () => {
    registerDashboardGlobals({ fleetRegistrar: store, fleetNonceStore: nonceStore });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const srv = await startTestServer();
    try {
      const body = await buildSignedRegistration({ baseUrl: srv.baseUrl, identity: id, hostname: 'dev-host', metadata: { region: 'eu' } });
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body });
      expect(r.status).toBe(200);
      const json = JSON.parse(r.body);
      expect(json.ok).toBe(true);
      expect(json.deviceId).toBe(id.deviceId);
      const row = store.get(id.deviceId);
      expect(row?.hostname).toBe('dev-host');
      expect(row?.admissionStatus).toBe('approved'); // slice 4 default
    } finally { await srv.close(); }
  });

  it('FR-03: bad signature → 400 invalid_registration / bad_signature', async () => {
    registerDashboardGlobals({ fleetRegistrar: store, fleetNonceStore: nonceStore });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const srv = await startTestServer();
    try {
      const { payload } = await buildSignedRegistration({ baseUrl: srv.baseUrl, identity: id });
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body: { payload, signature: 'AAAA' } });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body).reason).toBe('bad_signature');
    } finally { await srv.close(); }
  });

  it('FR-04: register is PUBLIC — no Bearer required even with auth enforced', async () => {
    registerDashboardGlobals({ fleetRegistrar: store, fleetNonceStore: nonceStore });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const srv = await startTestServer({ port: 0, authToken: 'fleet-bearer', refreshIntervalMs: 30000, loopbackTrust: false });
    try {
      const body = await buildSignedRegistration({ baseUrl: srv.baseUrl, identity: id });
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body });
      expect(r.status).toBe(200);
    } finally { await srv.close(); }
  });

  it('FR-05: malformed JSON body → 400', async () => {
    registerDashboardGlobals({ fleetRegistrar: store, fleetNonceStore: nonceStore });
    const srv = await startTestServer();
    try {
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

  it('FR-05b: replay of a captured registration → second attempt rejected (slice 4 hardening)', async () => {
    registerDashboardGlobals({ fleetRegistrar: store, fleetNonceStore: nonceStore });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const srv = await startTestServer();
    try {
      const body = await buildSignedRegistration({ baseUrl: srv.baseUrl, identity: id });
      const first = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body });
      expect(first.status).toBe(200);
      // Captured-body replay — nonce already consumed.
      const replay = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body });
      expect(replay.status).toBe(400);
      expect(JSON.parse(replay.body).reason).toBe('nonce_consumed_or_unknown');
    } finally { await srv.close(); }
  });
});

describe('GET /api/admin/fleet/devices (#28c slice 1, slice-4 fields surfaced)', () => {
  it('FR-06: registrar mode OFF → 503 fleet_registrar_not_enabled', async () => {
    process.env['SUDO_ADMIN_POWERS'] = '1';
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices`);
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).error).toBe('fleet_registrar_not_enabled');
    } finally { await srv.close(); }
  });

  it('FR-07: requires admin powers (503 when SUDO_ADMIN_POWERS=0)', async () => {
    delete process.env['SUDO_ADMIN_POWERS'];
    registerDashboardGlobals({ fleetRegistrar: store, fleetNonceStore: nonceStore });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices`);
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).error).toBe('admin_powers_disabled');
    } finally { await srv.close(); process.env['SUDO_ADMIN_POWERS'] = '1'; }
  });

  it('FR-08: requires Bearer without loopback-trust', async () => {
    registerDashboardGlobals({ fleetRegistrar: store, fleetNonceStore: nonceStore });
    const srv = await startTestServer({ port: 0, authToken: 'fleet-bearer', refreshIntervalMs: 30000, loopbackTrust: false });
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices`);
      expect(r.status).toBe(401);
    } finally { await srv.close(); }
  });

  it('FR-09: returns registered devices with PUBLIC KEY REDACTED + admission/lastSeen surfaced', async () => {
    process.env['SUDO_ADMIN_POWERS'] = '1';
    registerDashboardGlobals({ fleetRegistrar: store, fleetNonceStore: nonceStore });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    store.upsert({
      deviceId: id.deviceId,
      publicKeyPem: id.publicKeyPem,
      hostname: 'dev-1',
      versionStr: '4.1.0',
      metadata: { region: 'us' },
    });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices`);
      expect(r.status).toBe(200);
      const json = JSON.parse(r.body);
      expect(json.count).toBe(1);
      expect(json.devices[0].deviceId).toBe(id.deviceId);
      expect(json.devices[0].hostname).toBe('dev-1');
      expect(json.devices[0].publicKeyFingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(json.devices[0].publicKeyPem).toBeUndefined();
      expect(json.devices[0].metadata).toEqual({ region: 'us' });
      // Slice-4 fields.
      expect(json.devices[0].admissionStatus).toBe('approved');
      expect(json.devices[0].lastSeenAt).toBeNull();
    } finally { await srv.close(); }
  });

  it('FR-10: admin list honors ?limit=', async () => {
    process.env['SUDO_ADMIN_POWERS'] = '1';
    registerDashboardGlobals({ fleetRegistrar: store, fleetNonceStore: nonceStore });
    for (let i = 0; i < 5; i++) {
      store.upsert({
        deviceId: `aaaa${i}`.padEnd(16, '0'),
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n',
        hostname: `h${i}`,
        versionStr: '4.1.0',
      });
    }
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices?limit=2`);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).count).toBe(2);
    } finally { await srv.close(); }
  });
});

describe('end-to-end: device → registrar → admin list', () => {
  it('FR-11: full round-trip with two real devices', async () => {
    registerDashboardGlobals({ fleetRegistrar: store, fleetNonceStore: nonceStore });
    const id1 = createDeviceIdentity(path.join(tmp, 'id1.json'));
    const id2 = createDeviceIdentity(path.join(tmp, 'id2.json'));
    process.env['SUDO_ADMIN_POWERS'] = '1';
    const srv = await startTestServer();
    try {
      for (const [id, hostname] of [[id1, 'edge-A'] as const, [id2, 'edge-B'] as const]) {
        const body = await buildSignedRegistration({ baseUrl: srv.baseUrl, identity: id, hostname });
        const r = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body });
        expect(r.status).toBe(200);
      }
      const list = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices`);
      expect(list.status).toBe(200);
      const ids = (JSON.parse(list.body).devices as Array<{ deviceId: string }>).map((d) => d.deviceId).sort();
      expect(ids).toEqual([id1.deviceId, id2.deviceId].sort());
    } finally { await srv.close(); }
  });
});
