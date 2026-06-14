/**
 * @file tests/fleet/fleet-backchannel.test.ts
 * @description Gap #28c slice 2 — full HTTP integration of the back-channel:
 * admin dispatch → device long-poll inbox → device result POST → admin read.
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

let tmp: string;
let registry: RegistryStore;
let queue: CommandQueue;

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
  for (const k of ['__sudoBrain','__sudoGateway','__sudoAlignment','__sudoAgentSwarm','__sudoUpdater','__sudoAudit','__sudoAuthBackend','__sudoFleetRegistrar','__sudoFleetCommandQueue']) delete g[k];
}

beforeEach(() => {
  clearGlobals();
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-bc-'));
  registry = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db') });
  queue = new CommandQueue({ dbPath: path.join(tmp, 'fleet.db') });
});
afterEach(() => {
  queue.close();
  registry.close();
  rmSync(tmp, { recursive: true, force: true });
  clearGlobals();
});

function registerOneDevice(id: ReturnType<typeof createDeviceIdentity>, hostname: string): void {
  const payload: RegistrationPayload = {
    version: 1,
    deviceId: id.deviceId,
    publicKeyPem: id.publicKeyPem,
    hostname,
    version_str: '4.1.0',
    ts: Date.now(),
  };
  // Use the registry directly (we're not testing the register route here).
  registry.upsert({
    deviceId: id.deviceId,
    publicKeyPem: id.publicKeyPem,
    hostname,
    versionStr: '4.1.0',
  });
}

describe('POST /api/admin/fleet/dispatch', () => {
  it('BC-01: registrar mode OFF → 503', async () => {
    // No globals registered.
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/dispatch`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
        body: { deviceId: 'd', command: { kind: 'model.get' } },
      });
      expect(r.status).toBe(503);
    } finally { await srv.close(); }
  });

  it('BC-02: unknown device → 404 device_not_registered', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/dispatch`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
        body: { deviceId: 'unknown-device', command: { kind: 'model.get' } },
      });
      expect(r.status).toBe(404);
      expect(JSON.parse(r.body).error).toBe('device_not_registered');
    } finally { await srv.close(); }
  });

  it('BC-03: unsupported kind → 400 unsupported_command_kind', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registerOneDevice(id, 'd');
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/dispatch`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
        body: { deviceId: id.deviceId, command: { kind: 'shutdown.everything' } },
      });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body).error).toBe('unsupported_command_kind');
    } finally { await srv.close(); }
  });

  it('BC-04: valid dispatch → 202 + commandId, command stored', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registerOneDevice(id, 'd');
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/dispatch`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
        body: { deviceId: id.deviceId, command: { kind: 'model.get' } },
      });
      expect(r.status).toBe(202);
      const commandId = JSON.parse(r.body).commandId as string;
      expect(typeof commandId).toBe('string');
      expect(queue.get(commandId)?.status).toBe('queued');
    } finally { await srv.close(); }
  });
});

describe('GET /api/fleet/device/:id/inbox', () => {
  it('BC-05: signature required — no headers → 401', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registerOneDevice(id, 'd');
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/fleet/device/${id.deviceId}/inbox?wait=0`);
      expect(r.status).toBe(401);
    } finally { await srv.close(); }
  });

  it('BC-06: inbox empty + wait=0 → 204', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registerOneDevice(id, 'd');
    const path1 = `/api/fleet/device/${id.deviceId}/inbox`;
    const headers = signFleetRequest({ method: 'GET', path: path1, identity: id });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}${path1}?wait=0`, { headers });
      expect(r.status).toBe(204);
    } finally { await srv.close(); }
  });

  it('BC-07: enqueue → device long-poll wakes immediately and gets the command', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registerOneDevice(id, 'd');
    const path1 = `/api/fleet/device/${id.deviceId}/inbox`;
    const headers = signFleetRequest({ method: 'GET', path: path1, identity: id });
    const srv = await startTestServer();
    try {
      // Kick off the long-poll BEFORE enqueueing.
      const pollPromise = rawRequest(`${srv.baseUrl}${path1}?wait=5`, { headers });
      // Give the request a tick to install the waiter.
      await new Promise((r) => setTimeout(r, 50));
      queue.enqueue({ deviceId: id.deviceId, command: { kind: 'model.get' }, dispatcher: 'admin' });
      const r = await pollPromise;
      expect(r.status).toBe(200);
      const json = JSON.parse(r.body);
      expect(json.kind).toBe('model.get');
      expect(json.status).toBe('in_flight');
    } finally { await srv.close(); }
  });

  it('BC-08: signature from wrong key → 401 bad_signature', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const other = createDeviceIdentity(path.join(tmp, 'other.json'));
    registerOneDevice(id, 'd');
    const path1 = `/api/fleet/device/${id.deviceId}/inbox`;
    // Forge: claim it's `id`'s deviceId in the header but sign with `other`'s key.
    const otherHeaders = signFleetRequest({ method: 'GET', path: path1, identity: other });
    const headers = { ...otherHeaders, 'X-Fleet-Device-Id': id.deviceId };
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}${path1}?wait=0`, { headers });
      expect(r.status).toBe(401);
      expect(JSON.parse(r.body).reason).toBe('bad_signature');
    } finally { await srv.close(); }
  });
});

describe('POST /api/fleet/device/:id/result', () => {
  it('BC-09: result lands on in-flight command → 200 + admin read shows completed', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registerOneDevice(id, 'd');

    const commandId = queue.enqueue({ deviceId: id.deviceId, command: { kind: 'model.get' }, dispatcher: 'admin' });
    queue.pickup(id.deviceId); // simulate device having pulled it

    const path1 = `/api/fleet/device/${id.deviceId}/result`;
    const headers = signFleetRequest({ method: 'POST', path: path1, identity: id });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}${path1}`, {
        method: 'POST',
        headers,
        body: { commandId, status: 'completed', result: { model: 'gpt-4' } },
      });
      expect(r.status).toBe(200);

      // Admin read.
      const admin = await rawRequest(`${srv.baseUrl}/api/admin/fleet/commands/${commandId}`, {
        headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(admin.status).toBe(200);
      const json = JSON.parse(admin.body);
      expect(json.status).toBe('completed');
      expect(json.result).toEqual({ model: 'gpt-4' });
    } finally { await srv.close(); }
  });

  it('BC-10: result for unknown command → 404', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registerOneDevice(id, 'd');
    const path1 = `/api/fleet/device/${id.deviceId}/result`;
    const headers = signFleetRequest({ method: 'POST', path: path1, identity: id });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}${path1}`, {
        method: 'POST', headers, body: { commandId: 'nope', status: 'completed' },
      });
      expect(r.status).toBe(404);
    } finally { await srv.close(); }
  });

  it('BC-11: status must be completed|failed → 400', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registerOneDevice(id, 'd');
    const commandId = queue.enqueue({ deviceId: id.deviceId, command: { kind: 'model.get' }, dispatcher: 'admin' });
    queue.pickup(id.deviceId);
    const path1 = `/api/fleet/device/${id.deviceId}/result`;
    const headers = signFleetRequest({ method: 'POST', path: path1, identity: id });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}${path1}`, {
        method: 'POST', headers, body: { commandId, status: 'pending' },
      });
      expect(r.status).toBe(400);
    } finally { await srv.close(); }
  });

  it('BC-12: result for already-completed command → 409', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registerOneDevice(id, 'd');
    const commandId = queue.enqueue({ deviceId: id.deviceId, command: { kind: 'model.get' }, dispatcher: 'admin' });
    queue.pickup(id.deviceId);
    queue.complete({ commandId, result: { status: 'completed' } });
    const path1 = `/api/fleet/device/${id.deviceId}/result`;
    const headers = signFleetRequest({ method: 'POST', path: path1, identity: id });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}${path1}`, {
        method: 'POST', headers, body: { commandId, status: 'completed' },
      });
      expect(r.status).toBe(409);
    } finally { await srv.close(); }
  });
});

describe('GET /api/admin/fleet/commands/:id', () => {
  it('BC-13: unknown commandId → 404', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/commands/not-a-real-id`, {
        headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(r.status).toBe(404);
    } finally { await srv.close(); }
  });

  it('BC-14: admin-gated — without admin powers → 503', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    delete process.env['SUDO_ADMIN_POWERS'];
    const srv = await startTestServer();
    delete process.env['SUDO_ADMIN_POWERS']; // startTestServer sets it — re-clear after.
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/commands/whatever`, {
        headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(r.status).toBe(503);
    } finally {
      await srv.close();
      process.env['SUDO_ADMIN_POWERS'] = '1';
    }
  });
});
