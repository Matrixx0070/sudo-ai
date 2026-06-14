/**
 * @file tests/fleet/fleet-executor.test.ts
 * @description Gap #28c slice 2 — full end-to-end of the device executor
 * against a real loopback registrar. Admin dispatches → executor pulls and
 * runs → result is observable on the admin read endpoint.
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
import { runCommand, startFleetExecutor } from '../../src/core/fleet/fleet-executor.js';

let tmp: string;

function clearGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of ['__sudoBrain','__sudoGateway','__sudoAlignment','__sudoAgentSwarm','__sudoUpdater','__sudoAudit','__sudoAuthBackend','__sudoFleetRegistrar','__sudoFleetCommandQueue']) delete g[k];
}

beforeEach(() => { clearGlobals(); tmp = mkdtempSync(path.join(tmpdir(), 'sudo-exec-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); clearGlobals(); });

describe('runCommand', () => {
  it('EX-01: model.get with no brain → failed brain_not_registered', async () => {
    const r = await runCommand({ commandId: 'c1', kind: 'model.get' }, undefined);
    expect(r).toEqual({ status: 'failed', error: 'brain_not_registered' });
  });

  it('EX-02: model.get with brain → completed { model }', async () => {
    let model = 'gpt-4';
    const brain = { getModel: () => model, setModel: (m: string) => { model = m; } };
    const r = await runCommand({ commandId: 'c2', kind: 'model.get' }, brain);
    expect(r).toEqual({ status: 'completed', result: { model: 'gpt-4' } });
  });

  it('EX-03: model.set with brain → completed + brain updated', async () => {
    let model = 'gpt-4';
    const brain = { getModel: () => model, setModel: (m: string) => { model = m; } };
    const r = await runCommand({ commandId: 'c3', kind: 'model.set', args: { model: 'claude-sonnet-4-6' } }, brain);
    expect(r.status).toBe('completed');
    expect(model).toBe('claude-sonnet-4-6');
  });

  it('EX-04: model.set without args → failed', async () => {
    let model = 'gpt-4';
    const brain = { getModel: () => model, setModel: (m: string) => { model = m; } };
    const r = await runCommand({ commandId: 'c4', kind: 'model.set' }, brain);
    expect(r.status).toBe('failed');
  });

  it('EX-05: unsupported kind → failed unsupported_kind:X', async () => {
    const r = await runCommand({ commandId: 'c5', kind: 'wipe-the-box' }, undefined);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('unsupported_kind:wipe-the-box');
  });

  it('EX-06: brain throwing → failed with the error message (not a hard crash)', async () => {
    const brain = {
      getModel: () => { throw new Error('brain offline'); },
      setModel: () => undefined,
    };
    const r = await runCommand({ commandId: 'c6', kind: 'model.get' }, brain);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('brain offline');
  });
});

describe('startFleetExecutor end-to-end', () => {
  it('EX-07: admin dispatch → executor pulls + runs + posts result → admin sees completed', async () => {
    const registry = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db') });
    const queue = new CommandQueue({ dbPath: path.join(tmp, 'fleet.db') });
    process.env['SUDO_ADMIN_POWERS'] = '1';
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue });

    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({
      deviceId: id.deviceId,
      publicKeyPem: id.publicKeyPem,
      hostname: 'edge-1',
      versionStr: '4.1.0',
    });

    // Start a real loopback registrar dashboard.
    const cfg: DashboardConfig = { port: 0, authToken: 'admin-bearer', refreshIntervalMs: 30000, loopbackTrust: true };
    const server = new DashboardServer(cfg);
    const httpServer = http.createServer((req, res) => {
      Promise.resolve(registerRoutes(req, res, server, cfg)).catch((err) => {
        if (!res.headersSent) { res.writeHead(500); res.end(String(err)); }
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
      httpServer.on('error', reject);
    });
    const addr = httpServer.address() as import('node:net').AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Start the executor on the device side. Brain is a simple in-memory shim.
    let model = 'gpt-4';
    const brain = { getModel: () => model, setModel: (m: string) => { model = m; } };
    const exec = startFleetExecutor({
      registrarUrl: baseUrl,
      identity: id,
      brain,
      waitSeconds: 5,
      backoffBaseMs: 100,
      backoffMaxMs: 500,
    });

    // Admin dispatches a model.set command.
    const dispatch = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL('/api/admin/fleet/dispatch', baseUrl);
      const bodyStr = JSON.stringify({ deviceId: id.deviceId, command: { kind: 'model.set', args: { model: 'claude-sonnet-4-6' } } });
      const req = http.request({
        hostname: u.hostname, port: Number(u.port), path: u.pathname, method: 'POST',
        headers: {
          Authorization: 'Bearer admin-bearer',
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(bodyStr)),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });
    expect(dispatch.status).toBe(202);
    const commandId = JSON.parse(dispatch.body).commandId as string;

    // Poll the admin command endpoint until the executor reports back.
    const deadline = Date.now() + 5000;
    let final: { status: string } | null = null;
    while (Date.now() < deadline) {
      const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const u = new URL(`/api/admin/fleet/commands/${commandId}`, baseUrl);
        const req = http.request({
          hostname: u.hostname, port: Number(u.port), path: u.pathname, method: 'GET',
          headers: { Authorization: 'Bearer admin-bearer' },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
      });
      const json = JSON.parse(r.body);
      if (json.status === 'completed' || json.status === 'failed') { final = json; break; }
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(final?.status).toBe('completed');
    expect(model).toBe('claude-sonnet-4-6'); // brain was actually mutated

    await exec.stop();
    await new Promise<void>((resolve, reject) => httpServer.close((e) => (e ? reject(e) : resolve())));
    queue.close();
    registry.close();
  });
});
