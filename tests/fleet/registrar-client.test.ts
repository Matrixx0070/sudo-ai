/**
 * @file tests/fleet/registrar-client.test.ts
 * @description Gap #28c slice 1 — device-side HTTP client. End-to-end against
 * a real loopback dashboard with the registrar mounted (no fetch mocks).
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
import { createDeviceIdentity, defaultIdentityPath } from '../../src/core/fleet/device-identity.js';
import { RegistryStore } from '../../src/core/fleet/registry-store.js';
import { NonceStore } from '../../src/core/fleet/nonce-store.js';
import { registerWithRegistrar } from '../../src/core/fleet/registrar-client.js';
import type { DashboardConfig } from '../../src/core/dashboard/dashboard-types.js';

let tmp: string;
let store: RegistryStore;
let nonceStore: NonceStore;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'sudo-fleet-client-'));
  store = new RegistryStore({ dbPath: path.join(tmp, 'fleet.db') });
  nonceStore = new NonceStore();
  registerDashboardGlobals({ fleetRegistrar: store, fleetNonceStore: nonceStore });
});
afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
  const g = globalThis as Record<string, unknown>;
  delete g['__sudoFleetRegistrar'];
  delete g['__sudoFleetCommandQueue'];
  delete g['__sudoFleetNonceStore'];
});

function startTestServer(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const cfg: DashboardConfig = { port: 0, authToken: 'x', refreshIntervalMs: 30000, loopbackTrust: false };
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

describe('registerWithRegistrar', () => {
  it('RC-01: live round-trip — POST signed registration → 200 + row in store', async () => {
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const srv = await startTestServer();
    try {
      const r = await registerWithRegistrar({
        registrarUrl: srv.baseUrl,
        identity: id,
        versionStr: '4.1.0',
        hostname: 'client-host',
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.deviceId).toBe(id.deviceId);
      }
      expect(store.get(id.deviceId)?.hostname).toBe('client-host');
    } finally { await srv.close(); }
  });

  it('RC-02: invalid registrar URL → structural error, no throw', async () => {
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const r = await registerWithRegistrar({
      registrarUrl: 'not a url',
      identity: id,
      versionStr: '4.1.0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_registrar_url');
  });

  it('RC-03: unreachable registrar → network_error', async () => {
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    const r = await registerWithRegistrar({
      // Port 1 is always closed on Linux test runners; loopback refuses fast.
      registrarUrl: 'http://127.0.0.1:1',
      identity: id,
      versionStr: '4.1.0',
      timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Either 'network_error' (immediate refuse) or 'timeout' (slow tarpit) —
      // both are structural failures, not throws.
      expect(['network_error', 'timeout']).toContain(r.reason);
    }
  });

  it('RC-04: registrar returns 503 on challenge (mode off) → challenge_rejected with status', async () => {
    const id = createDeviceIdentity(defaultIdentityPath(tmp));
    // Unregister both fleet globals to simulate registrar mode OFF.
    const g = globalThis as Record<string, unknown>;
    delete g['__sudoFleetRegistrar'];
    delete g['__sudoFleetNonceStore'];
    const srv = await startTestServer();
    try {
      const r = await registerWithRegistrar({
        registrarUrl: srv.baseUrl,
        identity: id,
        versionStr: '4.1.0',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // Slice 4 — registerWithRegistrar GETs the challenge first; that
        // fails before we ever POST to /register, so the structural reason
        // is `challenge_rejected` not `registrar_rejected`.
        expect(r.reason).toBe('challenge_rejected');
        expect(r.status).toBe(503);
      }
    } finally { await srv.close(); }
  });
});
