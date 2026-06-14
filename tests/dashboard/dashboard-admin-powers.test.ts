/**
 * @file tests/dashboard/dashboard-admin-powers.test.ts
 * @description Admin-power endpoints (#28b slice 1): restart / update / model.
 *
 * Covers auth gate, opt-in gate, body validation, success paths, and
 * audit-trail wiring through a stub AuditSource.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardServer, registerDashboardGlobals } from '../../src/core/dashboard/dashboard-server.js';
import { registerRoutes } from '../../src/core/dashboard/dashboard-routes.js';
import type {
  DashboardConfig,
  BrainSource,
  UpdaterSource,
  AuditSource,
  UpdateCheckResult,
  UpdateApplyResult,
} from '../../src/core/dashboard/dashboard-types.js';

let testPortCounter = 19400;

function getTestConfig(overrides?: Partial<DashboardConfig>): DashboardConfig {
  return { port: testPortCounter++, authToken: 'test-admin-powers-token', refreshIntervalMs: 30000, ...overrides };
}

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
  dashboardServer: DashboardServer;
}

function startTestServer(config?: DashboardConfig): Promise<TestServer> {
  const cfg = config ?? getTestConfig();
  return new Promise((resolve, reject) => {
    const server = new DashboardServer(cfg);
    const httpServer = http.createServer((req, res) => registerRoutes(req, res, server, cfg));
    httpServer.listen(cfg.port, '127.0.0.1', () => {
      const addr = httpServer.address() as import('node:net').AddressInfo;
      const close = (): Promise<void> =>
        new Promise((res, rej) => httpServer.close((err) => (err ? rej(err) : res())));
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, close, dashboardServer: server });
    });
    httpServer.on('error', reject);
  });
}

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

function rawRequest(url: string, opts: {
  method?: string;
  token?: string;
  body?: unknown;
} = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (bodyStr !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method: opts.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

// Stubs that record what was called for assertions.
interface StubBrain extends BrainSource {
  switches: string[];
  modelToReturn: string;
  throwOnNext?: Error;
}
function makeStubBrain(initial = 'ollama/test:default'): StubBrain {
  return {
    switches: [],
    modelToReturn: initial,
    getModel() { return this.modelToReturn; },
    setModel(target: string) {
      if (this.throwOnNext) { const e = this.throwOnNext; this.throwOnNext = undefined; throw e; }
      this.switches.push(target);
      this.modelToReturn = target;
    },
  };
}

interface StubUpdater extends UpdaterSource {
  checkCalls: Array<string | undefined>;
  applyCalls: Array<string | undefined>;
  applyResolves: UpdateApplyResult;
  checkResolves: UpdateCheckResult;
}
function makeStubUpdater(): StubUpdater {
  return {
    checkCalls: [],
    applyCalls: [],
    applyResolves: { success: true, fromVersion: '0.1.0', toVersion: '0.2.0', stage: 'complete' },
    checkResolves: { available: true, currentVersion: '0.1.0', newVersion: '0.2.0', channel: 'latest' },
    async checkNow(channel?: string) { this.checkCalls.push(channel); return this.checkResolves; },
    async applyUpdate(channel?: string) { this.applyCalls.push(channel); return this.applyResolves; },
  };
}

interface StubAudit extends AuditSource {
  records: Array<Parameters<AuditSource['record']>[0]>;
}
function makeStubAudit(): StubAudit {
  return {
    records: [],
    record(entry) { this.records.push(entry); return `id-${this.records.length}`; },
  };
}

// Clean global registry between tests so cross-test leakage doesn't muddy assertions.
function clearGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  delete g['__sudoBrain'];
  delete g['__sudoGateway'];
  delete g['__sudoAlignment'];
  delete g['__sudoAgentSwarm'];
  delete g['__sudoUpdater'];
  delete g['__sudoAudit'];
}

describe('Dashboard admin powers (#28b slice 1)', () => {
  const servers: TestServer[] = [];

  beforeEach(() => {
    clearGlobals();
    process.env['SUDO_ADMIN_POWERS'] = '1';
    process.env['SUDO_DASHBOARD_RESTART_NOEXIT'] = '1';
  });

  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
    clearGlobals();
    delete process.env['SUDO_ADMIN_POWERS'];
    delete process.env['SUDO_DASHBOARD_RESTART_NOEXIT'];
  });

  // ---- Auth gate --------------------------------------------------------

  it('AP-01: POST /api/admin/restart without Bearer → 401', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/restart`, { method: 'POST', body: {} });
    expect(r.status).toBe(401);
  });

  it('AP-02: POST /api/admin/restart with Bearer but admin powers disabled → 503', async () => {
    delete process.env['SUDO_ADMIN_POWERS'];
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/restart`, {
      method: 'POST', token: 'test-admin-powers-token', body: {},
    });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).error).toBe('admin_powers_disabled');
  });

  // ---- Restart ----------------------------------------------------------

  it('AP-03: POST /api/admin/restart with Bearer + opt-in → 202 + audit row', async () => {
    const audit = makeStubAudit();
    registerDashboardGlobals({ audit });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/restart`, {
      method: 'POST', token: 'test-admin-powers-token', body: { reason: 'unit test' },
    });
    expect(r.status).toBe(202);
    const body = JSON.parse(r.body) as { accepted: boolean; acceptedAt: string; exitInMs: number };
    expect(body.accepted).toBe(true);
    expect(body.exitInMs).toBeGreaterThan(0);
    expect(audit.records.find((e) => e.action === 'admin.restart')).toBeDefined();
    expect(audit.records.find((e) => e.action === 'admin.restart')?.outcome).toBe('success');
  });

  // ---- Model GET --------------------------------------------------------

  it('AP-04: GET /api/admin/model without registered Brain → 503', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/model`, { method: 'GET', token: 'test-admin-powers-token' });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).error).toBe('brain_not_registered');
  });

  it('AP-05: GET /api/admin/model with registered Brain returns current model', async () => {
    const brain = makeStubBrain('ollama/foo:bar');
    registerDashboardGlobals({ brain });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/model`, { method: 'GET', token: 'test-admin-powers-token' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).model).toBe('ollama/foo:bar');
  });

  // ---- Model POST -------------------------------------------------------

  it('AP-06: POST /api/admin/model/set with empty body → 400', async () => {
    const brain = makeStubBrain();
    registerDashboardGlobals({ brain });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/model/set`, {
      method: 'POST', token: 'test-admin-powers-token', body: {},
    });
    expect(r.status).toBe(400);
    expect(brain.switches).toEqual([]);
  });

  it('AP-07: POST /api/admin/model/set with valid model → 200 + Brain called + audit success', async () => {
    const brain = makeStubBrain('ollama/old:default');
    const audit = makeStubAudit();
    registerDashboardGlobals({ brain, audit });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/model/set`, {
      method: 'POST', token: 'test-admin-powers-token', body: { model: 'ollama/new:default' },
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).model).toBe('ollama/new:default');
    expect(brain.switches).toEqual(['ollama/new:default']);
    const auditEntry = audit.records.find((e) => e.action === 'admin.model.set');
    expect(auditEntry?.outcome).toBe('success');
  });

  it('AP-08: POST /api/admin/model/set with non-allowlist model → 400 + audit denied', async () => {
    const brain = makeStubBrain();
    brain.throwOnNext = new Error('Model "bogus" is not configured. Available: ollama/test:default');
    const audit = makeStubAudit();
    registerDashboardGlobals({ brain, audit });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/model/set`, {
      method: 'POST', token: 'test-admin-powers-token', body: { model: 'bogus' },
    });
    expect(r.status).toBe(400);
    const auditEntry = audit.records.find((e) => e.action === 'admin.model.set');
    expect(auditEntry?.outcome).toBe('denied');
  });

  it('AP-08b: POST /api/admin/model/set without registered Brain → 503 + audit outcome "error" (NOT "denied")', async () => {
    // Distinguishes the brain_not_registered code path from the Brain-throws
    // path covered by AP-08. The two outcomes must differ in the audit chain
    // so a future reader can tell "wrong model name" from "brain missing".
    const audit = makeStubAudit();
    registerDashboardGlobals({ audit });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/model/set`, {
      method: 'POST', token: 'test-admin-powers-token', body: { model: 'ollama/anything:default' },
    });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).error).toBe('brain_not_registered');
    const auditEntry = audit.records.find((e) => e.action === 'admin.model.set');
    expect(auditEntry?.outcome).toBe('error');
    expect(auditEntry?.metadata?.['reason']).toBe('brain_not_registered');
  });

  // ---- Update -----------------------------------------------------------

  it('AP-09: POST /api/admin/update (default dry-run) → 200 + checkNow called, applyUpdate NOT called', async () => {
    const updater = makeStubUpdater();
    registerDashboardGlobals({ updater });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/update`, {
      method: 'POST', token: 'test-admin-powers-token', body: {},
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as UpdateCheckResult & { previewed: boolean };
    expect(body.previewed).toBe(true);
    expect(body.available).toBe(true);
    expect(body.newVersion).toBe('0.2.0');
    expect(updater.checkCalls).toHaveLength(1);
    expect(updater.applyCalls).toEqual([]);
  });

  it('AP-10: POST /api/admin/update {dry_run:false} → 202 + applyUpdate called', async () => {
    const updater = makeStubUpdater();
    registerDashboardGlobals({ updater });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/update`, {
      method: 'POST', token: 'test-admin-powers-token', body: { dry_run: false, channel: 'beta' },
    });
    expect(r.status).toBe(202);
    expect(JSON.parse(r.body).accepted).toBe(true);
    // applyUpdate is fire-and-forget; give the microtask queue a tick.
    await new Promise((r2) => setImmediate(r2));
    expect(updater.applyCalls).toEqual(['beta']);
  });

  it('AP-11: POST /api/admin/update without registered updater → 200 previewed=true + reason', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/update`, {
      method: 'POST', token: 'test-admin-powers-token', body: {},
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as UpdateCheckResult & { previewed: boolean };
    expect(body.available).toBe(false);
    expect(body.reason).toBe('updater_not_registered');
  });

  // ---- Method/path guards ----------------------------------------------

  it('AP-12: PATCH /api/admin/restart → 405', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/restart`, {
      method: 'PATCH', token: 'test-admin-powers-token',
    });
    expect(r.status).toBe(405);
  });

  it('AP-13: GET /api/admin/restart → 405 (POST-only)', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/restart`, {
      method: 'GET', token: 'test-admin-powers-token',
    });
    expect(r.status).toBe(405);
  });

  it('AP-14: POST /api/stats → 405 (GET-only)', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/stats`, {
      method: 'POST', token: 'test-admin-powers-token', body: {},
    });
    expect(r.status).toBe(405);
  });

  it('AP-15a: POST /api/admin/restart with ?token=... (no header) → 401 — query fallback is GET-only', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/restart?token=test-admin-powers-token`, {
      method: 'POST', body: {},
      // intentionally no `token` opt — header is omitted, only query string carries the token
    });
    expect(r.status).toBe(401);
  });

  it('AP-15b: GET /api/stats with ?token=... (no header) → 200 — query fallback still works for read routes', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/stats?token=test-admin-powers-token`, {
      method: 'GET',
    });
    expect(r.status).toBe(200);
  });

  it('AP-15: POST /api/admin/restart with malformed JSON → 400', async () => {
    const s = await startTestServer(); servers.push(s);
    const url = new URL(`${s.baseUrl}/api/admin/restart`);
    const r = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname, port: Number(url.port), path: url.pathname,
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-admin-powers-token',
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.write('not json {');
      req.end();
    });
    expect(r.status).toBe(400);
  });
});
