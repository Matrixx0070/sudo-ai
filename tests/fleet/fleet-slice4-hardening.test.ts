/**
 * @file tests/fleet/fleet-slice4-hardening.test.ts
 * @description Gap #28c slice 4 — full HTTP integration of the slice-4
 * hardening: nonce challenge round-trip, replay rejection, admission state
 * transitions, dispatch + inbox gating on revoked devices, heartbeat bump.
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
import { signFleetRequest } from '../../src/core/fleet/fleet-signature.js';
import { RegistryStore } from '../../src/core/fleet/registry-store.js';
import { CommandQueue } from '../../src/core/fleet/command-queue.js';
import { NonceStore } from '../../src/core/fleet/nonce-store.js';

let tmp: string;
let registry: RegistryStore;
let queue: CommandQueue;
let nonceStore: NonceStore;

function clearGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of ['__sudoBrain','__sudoGateway','__sudoAlignment','__sudoAgentSwarm','__sudoUpdater','__sudoAudit','__sudoAuthBackend','__sudoFleetRegistrar','__sudoFleetCommandQueue','__sudoFleetNonceStore']) delete g[k];
}

interface TestServer { baseUrl: string; close(): Promise<void> }
function startTestServer(): Promise<TestServer> {
  process.env['SUDO_ADMIN_POWERS'] = '1';
  const cfg: DashboardConfig = { port: 0, authToken: 'admin-bearer', refreshIntervalMs: 30000, loopbackTrust: true };
  return new Promise((resolve, reject) => {
    const server = new DashboardServer(cfg);
    const httpServer = http.createServer((req, res) => {
      Promise.resolve(registerRoutes(req, res, server, cfg)).catch((err) => {
        if (!res.headersSent) { res.writeHead(500); res.end(String(err)); }
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

function rawRequest(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: string }> {
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

beforeEach(() => {
  clearGlobals();
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-s4-'));
  registry = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db') });
  queue = new CommandQueue({ dbPath: path.join(tmp, 'fleet.db') });
  nonceStore = new NonceStore();
});
afterEach(() => {
  queue.close();
  registry.close();
  rmSync(tmp, { recursive: true, force: true });
  clearGlobals();
});

describe('GET /api/fleet/challenge (#28c slice 4)', () => {
  it('S4-01: registrar mode OFF → 503', async () => {
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/challenge?deviceId=any`);
      expect(r.status).toBe(503);
    } finally { await srv.close(); }
  });

  it('S4-02: missing deviceId → 400', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetNonceStore: nonceStore, fleetCommandQueue: queue });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/challenge`);
      expect(r.status).toBe(400);
    } finally { await srv.close(); }
  });

  it('S4-03: invalid deviceId (path-injection chars) → 400', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetNonceStore: nonceStore, fleetCommandQueue: queue });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/challenge?deviceId=${encodeURIComponent('/etc/passwd')}`);
      expect(r.status).toBe(400);
    } finally { await srv.close(); }
  });

  it('S4-04: valid request → 200 + nonce + expiresAtMs', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetNonceStore: nonceStore, fleetCommandQueue: queue });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/challenge?deviceId=test-device`);
      expect(r.status).toBe(200);
      const json = JSON.parse(r.body);
      expect(typeof json.nonce).toBe('string');
      expect(json.nonce.length).toBeGreaterThan(0);
      expect(json.expiresAtMs).toBeGreaterThan(Date.now());
    } finally { await srv.close(); }
  });
});

describe('Admission control (#28c slice 4)', () => {
  it('S4-05: POST /devices/:id/revoke → device admission_status = revoked', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue, fleetNonceStore: nonceStore });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/${id.deviceId}/revoke`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).admissionStatus).toBe('revoked');
      expect(registry.get(id.deviceId)?.admissionStatus).toBe('revoked');
    } finally { await srv.close(); }
  });

  it('S4-06: revoke → admit round-trip', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue, fleetNonceStore: nonceStore });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    const srv = await startTestServer();
    try {
      await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/${id.deviceId}/revoke`, { method: 'POST', headers: { Authorization: 'Bearer admin-bearer' } });
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/${id.deviceId}/admit`, { method: 'POST', headers: { Authorization: 'Bearer admin-bearer' } });
      expect(r.status).toBe(200);
      expect(registry.get(id.deviceId)?.admissionStatus).toBe('approved');
    } finally { await srv.close(); }
  });

  it('S4-07: revoke unknown device → 404', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue, fleetNonceStore: nonceStore });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/not-real/revoke`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(r.status).toBe(404);
    } finally { await srv.close(); }
  });

  it('S4-08: dispatch refuses revoked device → 403', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue, fleetNonceStore: nonceStore });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    registry.setAdmissionStatus(id.deviceId, 'revoked');
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/dispatch`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
        body: { deviceId: id.deviceId, command: { kind: 'model.get' } },
      });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).error).toBe('device_revoked');
    } finally { await srv.close(); }
  });

  it('S4-09: inbox refuses revoked device → 403 (even with valid signature)', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue, fleetNonceStore: nonceStore });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    registry.setAdmissionStatus(id.deviceId, 'revoked');
    const path1 = `/api/fleet/device/${id.deviceId}/inbox`;
    const headers = signFleetRequest({ method: 'GET', path: path1, identity: id });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}${path1}?wait=0`, { headers });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).error).toBe('device_revoked');
    } finally { await srv.close(); }
  });
});

describe('Heartbeat (#28c slice 4 — bumped on inbox poll)', () => {
  it('S4-10: lastSeenAt is null until first inbox poll, then a timestamp', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue, fleetNonceStore: nonceStore });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    expect(registry.get(id.deviceId)?.lastSeenAt).toBeNull();

    const path1 = `/api/fleet/device/${id.deviceId}/inbox`;
    const headers = signFleetRequest({ method: 'GET', path: path1, identity: id });
    const srv = await startTestServer();
    try {
      await rawRequest(`${srv.baseUrl}${path1}?wait=0`, { headers });
      const after = registry.get(id.deviceId)?.lastSeenAt;
      expect(after).not.toBeNull();
      expect(typeof after).toBe('string');
      expect(Date.parse(after as string)).toBeGreaterThan(Date.now() - 5000);
    } finally { await srv.close(); }
  });
});

describe('Full slice-4 e2e: nonce-secured register → admin revoke → dispatch refused', () => {
  it('S4-11: signed register works, replay rejected, revoke gate fires end-to-end', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue, fleetNonceStore: nonceStore });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const srv = await startTestServer();
    try {
      // 1. Challenge → nonce.
      const challenge = await rawRequest(`${srv.baseUrl}/api/fleet/challenge?deviceId=${encodeURIComponent(id.deviceId)}`);
      expect(challenge.status).toBe(200);
      const nonce = JSON.parse(challenge.body).nonce as string;

      // 2. Build + send signed registration.
      const payload: RegistrationPayload = {
        version: 2,
        deviceId: id.deviceId,
        publicKeyPem: id.publicKeyPem,
        hostname: 'edge-A',
        version_str: '4.1.0',
        ts: Date.now(),
        nonce,
      };
      const body = { payload, signature: id.sign(canonicalizePayload(payload)) };
      const reg = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body });
      expect(reg.status).toBe(200);

      // 3. Replay the SAME body — nonce already consumed.
      const replay = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body });
      expect(replay.status).toBe(400);
      expect(JSON.parse(replay.body).reason).toBe('nonce_consumed_or_unknown');

      // 4. Dispatch a command — works because device is approved by default.
      const dispatch = await rawRequest(`${srv.baseUrl}/api/admin/fleet/dispatch`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
        body: { deviceId: id.deviceId, command: { kind: 'model.get' } },
      });
      expect(dispatch.status).toBe(202);

      // 5. Admin revokes the device.
      const revoke = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/${id.deviceId}/revoke`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(revoke.status).toBe(200);

      // 6. Dispatch now refused.
      const dispatch2 = await rawRequest(`${srv.baseUrl}/api/admin/fleet/dispatch`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
        body: { deviceId: id.deviceId, command: { kind: 'model.get' } },
      });
      expect(dispatch2.status).toBe(403);

      // 7. Inbox poll also refused.
      const inboxPath = `/api/fleet/device/${id.deviceId}/inbox`;
      const inboxHeaders = signFleetRequest({ method: 'GET', path: inboxPath, identity: id });
      const inbox = await rawRequest(`${srv.baseUrl}${inboxPath}?wait=0`, { headers: inboxHeaders });
      expect(inbox.status).toBe(403);
    } finally { await srv.close(); }
  });
});
