/**
 * @file tests/fleet/fleet-pending-admission.test.ts
 * @description Gap #28c slice 4 follow-up — `pending` admission state +
 * SQLite-backed nonce store. Closes the two slice-4-final WEAKEST POINT
 * items:
 *
 *   1. In-memory nonce store can't be consumed across processes — a
 *      registrar behind a load balancer with N processes would drop
 *      challenges issued by a peer process.
 *   2. Admission was two-state (approved/revoked) only — no `pending`
 *      for operators wanting explicit admin approval before first
 *      command.
 *
 * This file exercises the HTTP gates and the cross-instance nonce
 * persistence. Unit-level coverage lives in `nonce-store.test.ts` +
 * `registry-store.test.ts`.
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
import { RegistryStore, resolveAdmissionDefault } from '../../src/core/fleet/registry-store.js';
import { CommandQueue } from '../../src/core/fleet/command-queue.js';
import { NonceStore } from '../../src/core/fleet/nonce-store.js';

let tmp: string;
let registry: RegistryStore;
let queue: CommandQueue;
let nonceStore: NonceStore;

function clearGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of [
    '__sudoBrain', '__sudoGateway', '__sudoAlignment', '__sudoAgentSwarm',
    '__sudoUpdater', '__sudoAudit', '__sudoAuthBackend',
    '__sudoFleetRegistrar', '__sudoFleetCommandQueue', '__sudoFleetNonceStore',
  ]) delete g[k];
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
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-s4-followup-'));
  // Default registry uses `approved` so tests opt in to `pending` where
  // they need it by constructing a fresh store at the same fleet.db.
  registry = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db') });
  queue = new CommandQueue({ dbPath: path.join(tmp, 'fleet.db') });
  nonceStore = new NonceStore({ dbPath: path.join(tmp, 'fleet.db') });
});
afterEach(() => {
  queue.close();
  registry.close();
  nonceStore.close();
  rmSync(tmp, { recursive: true, force: true });
  clearGlobals();
});

describe('resolveAdmissionDefault env reader', () => {
  it('FA-01: unset env → approved', () => {
    expect(resolveAdmissionDefault({})).toBe('approved');
  });
  it('FA-02: SUDO_FLEET_ADMISSION_DEFAULT=approved → approved', () => {
    expect(resolveAdmissionDefault({ SUDO_FLEET_ADMISSION_DEFAULT: 'approved' })).toBe('approved');
  });
  it('FA-03: SUDO_FLEET_ADMISSION_DEFAULT=pending → pending', () => {
    expect(resolveAdmissionDefault({ SUDO_FLEET_ADMISSION_DEFAULT: 'pending' })).toBe('pending');
  });
  it('FA-04: invalid value (e.g. revoked, garbage) falls back to approved', () => {
    expect(resolveAdmissionDefault({ SUDO_FLEET_ADMISSION_DEFAULT: 'revoked' })).toBe('approved');
    expect(resolveAdmissionDefault({ SUDO_FLEET_ADMISSION_DEFAULT: 'bogus' })).toBe('approved');
  });
});

describe('Pending admission state — HTTP gates', () => {
  it('FA-05: dispatch to a pending device → 403 device_pending', async () => {
    // Reopen the registry with pending default to get pending rows on insert.
    registry.close();
    registry = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db'), admissionDefault: 'pending' });
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue, fleetNonceStore: nonceStore });

    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    expect(registry.get(id.deviceId)?.admissionStatus).toBe('pending');

    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}/api/admin/fleet/dispatch`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
        body: { deviceId: id.deviceId, command: { kind: 'model.get' } },
      });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).error).toBe('device_pending');
    } finally { await srv.close(); }
  });

  it('FA-06: inbox poll from a pending device → 403 device_pending (signature valid)', async () => {
    registry.close();
    registry = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db'), admissionDefault: 'pending' });
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue, fleetNonceStore: nonceStore });

    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });

    const pathn = `/api/fleet/device/${id.deviceId}/inbox`;
    const headers = signFleetRequest({ method: 'GET', path: pathn, identity: id });
    const srv = await startTestServer();
    try {
      const r = await rawRequest(`${srv.baseUrl}${pathn}?wait=0`, { headers });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).error).toBe('device_pending');
    } finally { await srv.close(); }
  });

  it('FA-07: admit transitions pending → approved + dispatch then succeeds', async () => {
    registry.close();
    registry = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db'), admissionDefault: 'pending' });
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue, fleetNonceStore: nonceStore });

    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    expect(registry.get(id.deviceId)?.admissionStatus).toBe('pending');

    const srv = await startTestServer();
    try {
      const admit = await rawRequest(`${srv.baseUrl}/api/admin/fleet/devices/${id.deviceId}/admit`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
      });
      expect(admit.status).toBe(200);
      expect(JSON.parse(admit.body).admissionStatus).toBe('approved');

      const dispatch = await rawRequest(`${srv.baseUrl}/api/admin/fleet/dispatch`, {
        method: 'POST', headers: { Authorization: 'Bearer admin-bearer' },
        body: { deviceId: id.deviceId, command: { kind: 'model.get' } },
      });
      expect(dispatch.status).toBe(202);
    } finally { await srv.close(); }
  });

  it('FA-08: re-registration of a pending device PRESERVES pending (no silent auto-approve)', async () => {
    registry.close();
    registry = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db'), admissionDefault: 'pending' });
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.0' });
    expect(registry.get(id.deviceId)?.admissionStatus).toBe('pending');
    // A second registrar boot in `approved` default mode must NOT silently
    // promote the existing pending row when the device re-registers — the
    // admin's intent ("don't run anything yet") sticks.
    registry.close();
    registry = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db'), admissionDefault: 'approved' });
    registry.upsert({ deviceId: id.deviceId, publicKeyPem: id.publicKeyPem, hostname: 'd', versionStr: '4.1.1' });
    expect(registry.get(id.deviceId)?.admissionStatus).toBe('pending');
  });

  it('FA-09: registration response surfaces admissionStatus so the device sees it', async () => {
    registry.close();
    registry = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db'), admissionDefault: 'pending' });
    registerDashboardGlobals({ fleetRegistrar: registry, fleetCommandQueue: queue, fleetNonceStore: nonceStore });

    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const srv = await startTestServer();
    try {
      const challenge = await rawRequest(`${srv.baseUrl}/api/fleet/challenge?deviceId=${encodeURIComponent(id.deviceId)}`);
      expect(challenge.status).toBe(200);
      const nonce = JSON.parse(challenge.body).nonce as string;

      const payload: RegistrationPayload = {
        version: 2,
        deviceId: id.deviceId,
        publicKeyPem: id.publicKeyPem,
        hostname: 'edge-pending',
        version_str: '4.1.0',
        ts: Date.now(),
        nonce,
      };
      const body = { payload, signature: id.sign(canonicalizePayload(payload)) };
      const reg = await rawRequest(`${srv.baseUrl}/api/fleet/register`, { method: 'POST', body });
      expect(reg.status).toBe(200);
      expect(JSON.parse(reg.body).admissionStatus).toBe('pending');
    } finally { await srv.close(); }
  });
});

describe('SQLite NonceStore — cross-instance / multi-process safe', () => {
  it('FA-10: a nonce issued by one instance is consumable by another at the same dbPath', () => {
    // Instance A issues; instance B consumes — simulates the load-balanced
    // registrar where GET /challenge and POST /register land on different
    // workers.
    const dbPath = path.join(tmp, 'cross-process-fleet.db');
    const a = new NonceStore({ dbPath });
    const b = new NonceStore({ dbPath });
    try {
      const { nonce } = a.issue('dev-x');
      expect(b.consume('dev-x', nonce)).toBe(true);
      // Replay on either instance is rejected.
      expect(a.consume('dev-x', nonce)).toBe(false);
      expect(b.consume('dev-x', nonce)).toBe(false);
    } finally {
      a.close();
      b.close();
    }
  });

  it('FA-11: cross-instance count reflects both writers', () => {
    const dbPath = path.join(tmp, 'cross-count-fleet.db');
    const a = new NonceStore({ dbPath });
    const b = new NonceStore({ dbPath });
    try {
      a.issue('dev-a');
      b.issue('dev-b');
      expect(a.size()).toBe(2);
      expect(b.size()).toBe(2);
    } finally {
      a.close();
      b.close();
    }
  });

  it('FA-12: concurrent consume of the SAME nonce produces exactly one winner', async () => {
    // Same-process atomicity check — two `better-sqlite3` handles on the
    // same dbPath, each issuing a `DELETE … WHERE … RETURNING`. Because
    // better-sqlite3 is synchronous and Node is single-threaded, these
    // microtasks serialize on the JS event loop rather than physically
    // racing two writers. The test still proves the at-most-one-winner
    // property the operator-facing claim depends on: even when both
    // handles believe the nonce is valid, the second DELETE sees an
    // empty table and returns 0 rows. The cross-PROCESS WAL-writer-lock
    // claim in nonce-store.ts is correct by SQLite's documented
    // semantics — a true multi-process race would require spawning a
    // child Node process, which would slow the suite without changing
    // the assertion (DELETE … RETURNING is documented as a single
    // atomic write in any concurrency model SQLite supports).
    const dbPath = path.join(tmp, 'race-fleet.db');
    const a = new NonceStore({ dbPath });
    const b = new NonceStore({ dbPath });
    try {
      const { nonce } = a.issue('dev-race');
      const results = await Promise.all([
        Promise.resolve().then(() => a.consume('dev-race', nonce)),
        Promise.resolve().then(() => b.consume('dev-race', nonce)),
      ]);
      const winners = results.filter((x) => x === true).length;
      expect(winners).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });
});
