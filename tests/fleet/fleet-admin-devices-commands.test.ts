/**
 * @file tests/fleet/fleet-admin-devices-commands.test.ts
 * @description Gap #28c slice 3 — per-device command-history route.
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
import { RegistryStore } from '../../src/core/fleet/registry-store.js';
import { CommandQueue } from '../../src/core/fleet/command-queue.js';

let tmp: string;
let registry: RegistryStore;
let queue: CommandQueue;

function clearGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of ['__sudoBrain','__sudoGateway','__sudoAlignment','__sudoAgentSwarm','__sudoUpdater','__sudoAudit','__sudoAuthBackend','__sudoFleetRegistrar','__sudoFleetCommandQueue']) delete g[k];
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

function rawRequest(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname + parsed.search, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(() => {
  clearGlobals();
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-ui-'));
  registry = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db') });
  queue = new CommandQueue({ dbPath: path.join(tmp, 'fleet.db') });
});
afterEach(() => {
  queue.close();
  registry.close();
  rmSync(tmp, { recursive: true, force: true });
  clearGlobals();
});

describe('GET /api/admin/fleet/devices/:id/commands (#28c slice 3)', () => {
  it('UI-01: registrar mode OFF → 503', async () => {
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/anything/commands`, { Authorization: 'Bearer admin-bearer' });
      expect(r.status).toBe(503);
    } finally { await srv.close(); }
  });

  it('UI-02: unknown device → 404', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/not-real/commands`, { Authorization: 'Bearer admin-bearer' });
      expect(r.status).toBe(404);
      expect(JSON.parse(r.body).error).toBe('device_not_registered');
    } finally { await srv.close(); }
  });

  it('UI-03: empty device id → 400 invalid_device_id', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices//commands`, { Authorization: 'Bearer admin-bearer' });
      expect(r.status).toBe(400);
    } finally { await srv.close(); }
  });

  it('UI-04: empty history → 200 + count 0', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/${id.deviceId}/commands`, { Authorization: 'Bearer admin-bearer' });
      expect(r.status).toBe(200);
      const json = JSON.parse(r.body);
      expect(json.deviceId).toBe(id.deviceId);
      expect(json.count).toBe(0);
      expect(json.commands).toEqual([]);
    } finally { await srv.close(); }
  });

  it('UI-05: returns recent commands, most-recent first', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    queue.enqueue({ deviceId: id.deviceId, command: { kind: 'model.get' }, dispatcher: 'admin' });
    queue.enqueue({ deviceId: id.deviceId, command: { kind: 'model.set', args: { model: 'gpt-4' } }, dispatcher: 'admin' });
    queue.enqueue({ deviceId: id.deviceId, command: { kind: 'model.get' }, dispatcher: 'admin' });
    // Enqueue a command for a DIFFERENT device — must not leak into our list.
    const other = createDeviceIdentity(path.join(tmp, 'other.json'));
    registry.upsert({ deviceId: other.deviceId, publicKeyPem: other.publicKeyPem, hostname: 'o', versionStr: '4.1.0' });
    queue.enqueue({ deviceId: other.deviceId, command: { kind: 'model.get' }, dispatcher: 'admin' });

    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/${id.deviceId}/commands`, { Authorization: 'Bearer admin-bearer' });
      expect(r.status).toBe(200);
      const json = JSON.parse(r.body);
      expect(json.count).toBe(3);
      // Most-recent first.
      expect(json.commands[0].kind).toBe('model.get');
      // The other device's command must NOT appear.
      expect(json.commands.every((c: { deviceId: string }) => c.deviceId === id.deviceId)).toBe(true);
    } finally { await srv.close(); }
  });

  it('UI-06: ?limit= clamps the list', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    for (let i = 0; i < 5; i++) queue.enqueue({ deviceId: id.deviceId, command: { kind: 'model.get' }, dispatcher: 'admin' });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/${id.deviceId}/commands?limit=2`, { Authorization: 'Bearer admin-bearer' });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).count).toBe(2);
    } finally { await srv.close(); }
  });

  it('UI-07: requires admin opt-in (503 when SUDO_ADMIN_POWERS=0)', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    delete process.env['SUDO_ADMIN_POWERS'];
    const srv = await startTestServer();
    delete process.env['SUDO_ADMIN_POWERS'];
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/${id.deviceId}/commands`, { Authorization: 'Bearer admin-bearer' });
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).error).toBe('admin_powers_disabled');
    } finally { await srv.close(); process.env['SUDO_ADMIN_POWERS'] = '1'; }
  });

  it('UI-08: commands payload shape — completed result roundtrips through projection', async () => {
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    const commandId = queue.enqueue({ deviceId: id.deviceId, command: { kind: 'model.set', args: { model: 'gpt-4' } }, dispatcher: 'admin' });
    queue.pickup(id.deviceId);
    queue.complete({ commandId, result: { status: 'completed', result: { model: 'gpt-4' } } });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/${id.deviceId}/commands`, { Authorization: 'Bearer admin-bearer' });
      const json = JSON.parse(r.body);
      const row = json.commands[0];
      expect(row.commandId).toBe(commandId);
      expect(row.kind).toBe('model.set');
      expect(row.args).toEqual({ model: 'gpt-4' });
      expect(row.status).toBe('completed');
      expect(row.result).toEqual({ model: 'gpt-4' });
      // Internal raw columns NOT in the projection.
      expect(row.resultJson).toBeUndefined();
      expect(row.argsJson).toBeUndefined();
      expect(row.errorMessage).toBeUndefined();
    } finally { await srv.close(); }
  });
});
