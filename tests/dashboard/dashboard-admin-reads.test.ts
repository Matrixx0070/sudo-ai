/**
 * @file tests/dashboard/dashboard-admin-reads.test.ts
 * @description Admin-power READ endpoints (#28b slice 3):
 *   GET /api/admin/credentials  — vault metadata (no decryption)
 *   GET /api/admin/logs         — process-local log ring tail
 *   GET /api/admin/debug-share  — single JSON support bundle (redacted)
 *
 * Covers: opt-in gate, Bearer gate, query-token fallback, redaction (env +
 * deep object), legacy vault file handling, log ring capacity + ordering +
 * ?lines= clamp, debug-share schema + safe.try-catch fallback, audit chain.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DashboardServer, registerDashboardGlobals } from '../../src/core/dashboard/dashboard-server.js';
import { registerRoutes } from '../../src/core/dashboard/dashboard-routes.js';
import type { DashboardConfig, AuditSource, BrainSource } from '../../src/core/dashboard/dashboard-types.js';
import {
  LogRing,
  _clearRegisteredLogRing,
  attachLogRing,
  getRegisteredLogRing,
} from '../../src/core/dashboard/log-ring.js';
import { listCredentialsMetadata } from '../../src/core/dashboard/credentials-meta.js';
import {
  buildDebugShareSnapshot,
  redactDeep,
  _SENSITIVE_KEY_REGEX,
} from '../../src/core/dashboard/debug-share.js';

const TEST_TOKEN = 'test-slice3-token';

function getTestConfig(overrides?: Partial<DashboardConfig>): DashboardConfig {
  return {
    port: 0, // OS-assigned
    authToken: TEST_TOKEN,
    refreshIntervalMs: 30000,
    bindAddress: '127.0.0.1',
    loopbackTrust: false, // default off so auth gate is exercised
    ...overrides,
  };
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

function rawRequest(url: string, opts: { method?: string; token?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
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
    req.end();
  });
}

interface StubAudit extends AuditSource {
  records: Array<Parameters<AuditSource['record']>[0]>;
}
function makeStubAudit(): StubAudit {
  return { records: [], record(entry) { this.records.push(entry); return `id-${this.records.length}`; } };
}
function makeStubBrain(model = 'ollama/test:default'): BrainSource {
  return { getModel() { return model; }, setModel() { /* no-op */ } };
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
  _clearRegisteredLogRing();
}

// ────────────────────────────────────────────────────────────────────────────
// 1. LogRing pure unit tests
// ────────────────────────────────────────────────────────────────────────────

describe('LogRing (#28b slice 3)', () => {
  // Belt-and-suspenders global-slot hygiene so a leak from a different
  // describe block can't preset `globalThis.__sudoLogRing` and make the
  // attachLogRing-idempotency test misbehave. Each unit constructs its
  // own `new LogRing()` so the global slot isn't touched in normal flow.
  beforeEach(() => { _clearRegisteredLogRing(); });
  afterEach(() => { _clearRegisteredLogRing(); });

  it('LR-01: rejects non-positive capacity', () => {
    expect(() => new LogRing(0)).toThrow();
    expect(() => new LogRing(-1)).toThrow();
    expect(() => new LogRing(Number.NaN)).toThrow();
  });

  it('LR-02: capacity returned + size starts at 0', () => {
    const r = new LogRing(50);
    expect(r.capacity()).toBe(50);
    expect(r.size()).toBe(0);
  });

  it('LR-03: push splits embedded newlines, drops trailing empty', () => {
    const r = new LogRing(100);
    r.push('stdout', 'line1\nline2\nline3\n');
    expect(r.size()).toBe(3);
    expect(r.tail(10).map((l) => l.text)).toEqual(['line1', 'line2', 'line3']);
  });

  it('LR-04: push retains mid-string blank line as one entry', () => {
    const r = new LogRing(100);
    r.push('stdout', 'a\n\nb\n');
    expect(r.tail(10).map((l) => l.text)).toEqual(['a', '', 'b']);
  });

  it('LR-05: capacity overrun drops oldest', () => {
    const r = new LogRing(3);
    for (let i = 0; i < 10; i++) r.push('stdout', `line${i}\n`);
    expect(r.size()).toBe(3);
    expect(r.tail(10).map((l) => l.text)).toEqual(['line7', 'line8', 'line9']);
  });

  it('LR-06: tail clamps oversized request to buffer length without throwing', () => {
    const r = new LogRing(3);
    r.push('stdout', 'a\nb\n');
    expect(r.tail(9999).length).toBe(2);
  });

  it('LR-07: tail defaults to 200 on NaN/zero', () => {
    const r = new LogRing(500);
    for (let i = 0; i < 250; i++) r.push('stdout', `l${i}\n`);
    expect(r.tail(Number.NaN).length).toBe(200);
    expect(r.tail(0).length).toBe(200);
    expect(r.tail(-5).length).toBe(200);
  });

  it('LR-08: tail respects MAX_USER_LINES_REQUEST hard cap of 5000', () => {
    const r = new LogRing(7000);
    for (let i = 0; i < 6000; i++) r.push('stdout', `l${i}\n`);
    expect(r.tail(99999).length).toBe(5000);
  });

  it('LR-09: 8 KB line truncated with marker', () => {
    const r = new LogRing(10);
    const big = 'x'.repeat(9000);
    r.push('stdout', big + '\n');
    expect(r.tail(1)[0]?.text.endsWith('[truncated]')).toBe(true);
  });

  it('LR-10: ts is ISO 8601', () => {
    const r = new LogRing(5);
    r.push('stdout', 'hello\n');
    const e = r.tail(1)[0];
    expect(e?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('LR-11: attach captures real stdout.write without breaking original', () => {
    const r = new LogRing(50);
    let captured = '';
    const orig = process.stdout.write.bind(process.stdout);
    // Re-wrap so we capture original output too without polluting test runner.
    process.stdout.write = ((chunk: unknown) => {
      if (typeof chunk === 'string') captured += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      r.attach();
      process.stdout.write('hello world\n');
      r.detach();
    } finally {
      process.stdout.write = orig;
    }
    expect(captured).toContain('hello world');
    expect(r.tail(10).map((l) => l.text)).toContain('hello world');
  });

  it('LR-12: attachLogRing honors SUDO_DASHBOARD_LOG_RING_DISABLE=1', () => {
    process.env['SUDO_DASHBOARD_LOG_RING_DISABLE'] = '1';
    try {
      const r = attachLogRing(100);
      expect(r).toBeUndefined();
      expect(getRegisteredLogRing()).toBeUndefined();
    } finally {
      delete process.env['SUDO_DASHBOARD_LOG_RING_DISABLE'];
    }
  });

  it('LR-13: attach is idempotent', () => {
    const r = new LogRing(20);
    r.attach();
    r.attach();
    r.detach();
    // No throw + nothing weird. Tested by getting here without error.
    expect(r.size()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. credentials-meta pure unit tests
// ────────────────────────────────────────────────────────────────────────────

describe('credentials-meta listCredentialsMetadata (#28b slice 3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-creds-meta-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('CM-01: missing vault dir → vaultDirPresent:false, empty namespaces', () => {
    const snap = listCredentialsMetadata(path.join(tmpDir, 'does-not-exist'));
    expect(snap.vaultDirPresent).toBe(false);
    expect(snap.namespaces).toEqual([]);
  });

  it('CM-02: empty vault dir → vaultDirPresent:true, empty namespaces', () => {
    const snap = listCredentialsMetadata(tmpDir);
    expect(snap.vaultDirPresent).toBe(true);
    expect(snap.namespaces).toEqual([]);
  });

  it('CM-03: v2 namespace parsed; ciphertext NEVER surfaces', () => {
    const ns: import('../../src/core/security/vault.js').VaultNamespaceFile = {
      kdfSalt: '0011aabbccdd1122334455',
      entries: {
        'openai-api-key': {
          ciphertext: 'deadbeef',
          nonce: 'cafebabe',
          tag: 'feedface',
          createdAt: '2026-01-01T00:00:00Z',
        },
        'anthropic-token': {
          ciphertext: 'aaaa',
          nonce: 'bbbb',
          tag: 'cccc',
          createdAt: '2026-02-01T00:00:00Z',
          rotatedAt: '2026-03-01T00:00:00Z',
          expiresAt: '2099-12-31T00:00:00Z',
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'prod.json'), JSON.stringify(ns));
    const snap = listCredentialsMetadata(tmpDir);
    expect(snap.namespaces).toHaveLength(1);
    const prod = snap.namespaces[0];
    expect(prod?.format).toBe('v2');
    if (prod?.format !== 'v2') throw new Error('format guard');
    expect(prod.entries.map((e) => e.key).sort()).toEqual(['anthropic-token', 'openai-api-key']);
    const ant = prod.entries.find((e) => e.key === 'anthropic-token');
    expect(ant?.rotatedAt).toBe('2026-03-01T00:00:00Z');
    expect(ant?.expiresAt).toBe('2099-12-31T00:00:00Z');
    expect(ant?.expired).toBeUndefined();
    // Critical: ciphertext / nonce / tag fields must NOT leak into the response.
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('deadbeef');
    expect(serialized).not.toContain('cafebabe');
    expect(serialized).not.toContain('feedface');
  });

  it('CM-04: expired entry flagged', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'staging.json'),
      JSON.stringify({
        kdfSalt: 'aa',
        entries: {
          expired: {
            ciphertext: 'x', nonce: 'y', tag: 'z',
            createdAt: '2020-01-01T00:00:00Z',
            expiresAt: '2020-12-31T00:00:00Z',
          },
        },
      }),
    );
    const snap = listCredentialsMetadata(tmpDir);
    const e = snap.namespaces[0];
    if (e?.format !== 'v2') throw new Error('format guard');
    expect(e.entries[0]?.expired).toBe(true);
  });

  it('CM-05: legacy-v1 file → format=legacy-v1', () => {
    // Legacy shape: top-level keys are VaultEntries, no kdfSalt.
    fs.writeFileSync(
      path.join(tmpDir, 'old.json'),
      JSON.stringify({ 'some-key': { ciphertext: 'a', nonce: 'b', tag: 'c', createdAt: '2024-01-01T00:00:00Z' } }),
    );
    const snap = listCredentialsMetadata(tmpDir);
    expect(snap.namespaces[0]?.format).toBe('legacy-v1');
  });

  it('CM-06: malformed JSON → format=unreadable', () => {
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), 'this is not json');
    const snap = listCredentialsMetadata(tmpDir);
    expect(snap.namespaces[0]?.format).toBe('unreadable');
  });

  it('CM-07: audit.log + *.tmp.json skipped', () => {
    fs.writeFileSync(path.join(tmpDir, 'audit.log'), 'noise');
    fs.writeFileSync(path.join(tmpDir, 'mid-write.tmp.json'), '{}');
    fs.writeFileSync(
      path.join(tmpDir, 'real.json'),
      JSON.stringify({ kdfSalt: 'aa', entries: {} }),
    );
    const snap = listCredentialsMetadata(tmpDir);
    expect(snap.namespaces.map((n) => n.namespace)).toEqual(['real']);
  });

  it('CM-08: vaultConfigured reflects env presence', () => {
    delete process.env['SUDO_VAULT_MASTER_KEY'];
    delete process.env['SUDO_VAULT_PASSPHRASE'];
    expect(listCredentialsMetadata(tmpDir).vaultConfigured).toBe(false);
    process.env['SUDO_VAULT_PASSPHRASE'] = 'foo';
    try {
      expect(listCredentialsMetadata(tmpDir).vaultConfigured).toBe(true);
    } finally {
      delete process.env['SUDO_VAULT_PASSPHRASE'];
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. debug-share pure unit tests
// ────────────────────────────────────────────────────────────────────────────

describe('debug-share buildDebugShareSnapshot (#28b slice 3)', () => {
  it('DS-01: sensitive regex matches expected key shapes', () => {
    expect(_SENSITIVE_KEY_REGEX.test('OPENAI_API_KEY')).toBe(true);
    expect(_SENSITIVE_KEY_REGEX.test('authToken')).toBe(true);
    expect(_SENSITIVE_KEY_REGEX.test('SECRET_X')).toBe(true);
    expect(_SENSITIVE_KEY_REGEX.test('PASSWORD')).toBe(true);
    expect(_SENSITIVE_KEY_REGEX.test('jwt')).toBe(true);
    expect(_SENSITIVE_KEY_REGEX.test('credential')).toBe(true);
    expect(_SENSITIVE_KEY_REGEX.test('uptime')).toBe(false);
    expect(_SENSITIVE_KEY_REGEX.test('model')).toBe(false);
  });

  it('DS-02: redactDeep replaces sensitive string values without touching neighbours', () => {
    const input = {
      model: 'ollama/test',
      authToken: 'abc-def-ghi',
      nested: { OPENAI_API_KEY: 'sk-real-key', innocuous: 42 },
      arr: ['safe', { password: 'oops' }],
    };
    const out = redactDeep(input) as Record<string, unknown>;
    expect(out.model).toBe('ollama/test');
    expect(out.authToken).toBe('<redacted>');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.OPENAI_API_KEY).toBe('<redacted>');
    expect(nested.innocuous).toBe(42);
    const arr = out.arr as Array<unknown>;
    expect(arr[0]).toBe('safe');
    expect((arr[1] as Record<string, unknown>).password).toBe('<redacted>');
  });

  it('DS-03: redactDeep handles cycles + max depth', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', a };
    a.b = b;
    const out = redactDeep(a) as Record<string, unknown>;
    // No throw, cycle short-circuited with '<cycle>' marker.
    expect(JSON.stringify(out)).toContain('<cycle>');
  });

  it('DS-04: env allowlist + redaction', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['SUDO_VAULT_MASTER_KEY'] = 'deadbeef'.repeat(8);
    process.env['SUDO_ADMIN_POWERS'] = '1';
    try {
      const snap = buildDebugShareSnapshot({});
      // Allowlisted, non-sensitive: surfaced verbatim.
      expect(snap.env.NODE_ENV).toBe('test');
      expect(snap.env.SUDO_ADMIN_POWERS).toBe('1');
      // Allowlist sentinel: present, value is the boolean string. Asserting
      // the EXACT value catches a future contributor who removes the special-
      // case `continue` and falls through to `redactEnvValue`, which would
      // turn the sentinel into `<redacted>` since `SUDO_VAULT_MASTER_KEY_PRESENT`
      // matches SENSITIVE_KEY_REGEX (`KEY`).
      expect(snap.env.SUDO_VAULT_MASTER_KEY_PRESENT).toBe('true');
      expect(snap.env.SUDO_VAULT_MASTER_KEY_PRESENT).not.toBe('<redacted>');
      // Raw master key MUST NOT appear anywhere in the env block.
      expect(JSON.stringify(snap.env)).not.toContain('deadbeef');
    } finally {
      delete process.env['SUDO_VAULT_MASTER_KEY'];
      delete process.env['SUDO_ADMIN_POWERS'];
    }
  });

  it('DS-05: subsystem accessor that throws becomes {_error}, not 500', () => {
    const snap = buildDebugShareSnapshot({
      stats: () => { throw new Error('boom'); },
      health: () => ({ checks: [] }),
    });
    // _error wrapper applied to throwing subsystem.
    expect(snap.stats).toEqual({ _error: 'boom' });
    expect(snap.health).toEqual({ checks: [] });
  });

  it('DS-06: model not_registered when callback returns undefined', () => {
    const snap = buildDebugShareSnapshot({ currentModel: () => undefined });
    expect(snap.model).toBe('not_registered');
  });

  it('DS-07: process block always present + has node/pkgVersion', () => {
    const snap = buildDebugShareSnapshot({});
    expect(snap.process.node).toBe(process.version);
    expect(typeof snap.process.pkgVersion).toBe('string');
    expect(snap.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. End-to-end HTTP tests over a real server
// ────────────────────────────────────────────────────────────────────────────

describe('Admin-read HTTP endpoints (#28b slice 3)', () => {
  const servers: TestServer[] = [];

  beforeEach(() => {
    clearGlobals();
    process.env['SUDO_ADMIN_POWERS'] = '1';
  });
  afterEach(async () => {
    for (const s of servers) await s.close();
    servers.length = 0;
    clearGlobals();
    delete process.env['SUDO_ADMIN_POWERS'];
  });

  // ---- Opt-in gate ------------------------------------------------------

  it('AR-01: GET /api/admin/credentials without opt-in → 503 admin_powers_disabled', async () => {
    delete process.env['SUDO_ADMIN_POWERS'];
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/credentials`, { token: TEST_TOKEN });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).error).toBe('admin_powers_disabled');
  });

  it('AR-02: GET /api/admin/logs without opt-in → 503', async () => {
    delete process.env['SUDO_ADMIN_POWERS'];
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/logs`, { token: TEST_TOKEN });
    expect(r.status).toBe(503);
  });

  it('AR-03: GET /api/admin/debug-share without opt-in → 503', async () => {
    delete process.env['SUDO_ADMIN_POWERS'];
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/debug-share`, { token: TEST_TOKEN });
    expect(r.status).toBe(503);
  });

  // ---- Auth gate --------------------------------------------------------

  it('AR-04: GET /api/admin/credentials without Bearer → 401', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/credentials`);
    expect(r.status).toBe(401);
  });

  it('AR-05: GET /api/admin/debug-share with ?token= query → 200 (read-route ergonomics)', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/debug-share?token=${TEST_TOKEN}`);
    expect(r.status).toBe(200);
  });

  it('AR-06: GET /api/admin/logs with Bearer → 200 (default 200 lines)', async () => {
    const ring = attachLogRing(50);
    try {
      ring?.push('stdout', 'hello\nworld\n');
      const s = await startTestServer(); servers.push(s);
      const r = await rawRequest(`${s.baseUrl}/api/admin/logs`, { token: TEST_TOKEN });
      expect(r.status).toBe(200);
      const body = JSON.parse(r.body) as { available: boolean; lines: Array<{ text: string }>; capacity: number };
      expect(body.available).toBe(true);
      expect(body.capacity).toBe(50);
      expect(body.lines.map((l) => l.text)).toContain('hello');
    } finally {
      ring?.detach();
      _clearRegisteredLogRing();
    }
  });

  // ---- Loopback-trust ---------------------------------------------------

  it('AR-07: loopback-trust skips auth on admin GET reads', async () => {
    const s = await startTestServer(getTestConfig({ loopbackTrust: true })); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/credentials`);
    // No Bearer → still 200 because loopback-trust is active.
    expect(r.status).toBe(200);
  });

  it('AR-07b: loopback-trust does NOT bypass admin POSTs (sanity vs slice 2)', async () => {
    const s = await startTestServer(getTestConfig({ loopbackTrust: true })); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/restart`, { method: 'POST' });
    expect(r.status).toBe(401);
  });

  // ---- credentials endpoint --------------------------------------------

  it('AR-08: GET /api/admin/credentials returns metadata snapshot shape', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/credentials`, { token: TEST_TOKEN });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as ReturnType<typeof listCredentialsMetadata>;
    expect(typeof body.vaultDir).toBe('string');
    expect(typeof body.vaultDirPresent).toBe('boolean');
    expect(typeof body.vaultConfigured).toBe('boolean');
    expect(Array.isArray(body.namespaces)).toBe(true);
  });

  it('AR-08b: GET /api/admin/credentials fires audit chain entry', async () => {
    const audit = makeStubAudit();
    registerDashboardGlobals({ audit });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/credentials`, { token: TEST_TOKEN });
    expect(r.status).toBe(200);
    const entry = audit.records.find((e) => e.action === 'admin.credentials.read');
    expect(entry?.outcome).toBe('success');
    expect(entry?.resource).toBe('vault');
    expect(entry?.actor.startsWith('dashboard:')).toBe(true);
  });

  // ---- logs endpoint ----------------------------------------------------

  it('AR-09: GET /api/admin/logs with no ring → 503 log_ring_not_registered', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/logs`, { token: TEST_TOKEN });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).reason).toBe('log_ring_not_registered');
  });

  it('AR-10: GET /api/admin/logs?lines=2 returns at most 2', async () => {
    const ring = attachLogRing(50);
    try {
      for (let i = 0; i < 10; i++) ring?.push('stdout', `line${i}\n`);
      const s = await startTestServer(); servers.push(s);
      const r = await rawRequest(`${s.baseUrl}/api/admin/logs?lines=2`, { token: TEST_TOKEN });
      expect(r.status).toBe(200);
      const body = JSON.parse(r.body) as { lines: Array<{ text: string }> };
      expect(body.lines.length).toBe(2);
      expect(body.lines.map((l) => l.text)).toEqual(['line8', 'line9']);
    } finally {
      ring?.detach();
      _clearRegisteredLogRing();
    }
  });

  it('AR-10b: lines=non-numeric → server falls back to default 200', async () => {
    const ring = attachLogRing(50);
    try {
      ring?.push('stdout', 'x\n');
      const s = await startTestServer(); servers.push(s);
      const r = await rawRequest(`${s.baseUrl}/api/admin/logs?lines=banana`, { token: TEST_TOKEN });
      expect(r.status).toBe(200);
      const body = JSON.parse(r.body) as { lines: unknown[] };
      // Buffer has 1 line; default 200 clamps to length.
      expect(body.lines.length).toBe(1);
    } finally {
      ring?.detach();
      _clearRegisteredLogRing();
    }
  });

  // ---- debug-share endpoint --------------------------------------------

  it('AR-11: GET /api/admin/debug-share returns expected fields + redacts env', async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['SUDO_VAULT_MASTER_KEY'] = 'ff'.repeat(32);
    const brain = makeStubBrain('ollama/foo:bar');
    registerDashboardGlobals({ brain });
    try {
      const s = await startTestServer(getTestConfig({
        bindAddress: '127.0.0.1',
        hostAllowlist: ['localhost', '127.0.0.1'],
      })); servers.push(s);
      const r = await rawRequest(`${s.baseUrl}/api/admin/debug-share`, { token: TEST_TOKEN });
      expect(r.status).toBe(200);
      const body = JSON.parse(r.body) as ReturnType<typeof buildDebugShareSnapshot>;
      expect(typeof body.generatedAt).toBe('string');
      expect(body.process.node).toBe(process.version);
      expect(body.model).toBe('ollama/foo:bar');
      expect(body.dashboard.bind).toBe('127.0.0.1');
      expect(body.dashboard.adminPowers).toBe(true);
      // Sentinel says vault key IS present, but the raw key value never leaks.
      expect(body.env.SUDO_VAULT_MASTER_KEY_PRESENT).toBe('true');
      expect(r.body).not.toContain('ff'.repeat(32));
    } finally {
      delete process.env['SUDO_VAULT_MASTER_KEY'];
    }
  });

  it('AR-11b: debug-share fires audit chain entry with env-key count', async () => {
    const audit = makeStubAudit();
    registerDashboardGlobals({ audit });
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/debug-share`, { token: TEST_TOKEN });
    expect(r.status).toBe(200);
    const entry = audit.records.find((e) => e.action === 'admin.debug-share.read');
    expect(entry?.outcome).toBe('success');
    expect(typeof entry?.metadata?.['envKeysReturned']).toBe('number');
  });

  // ---- 405 / 404 / method-mismatch --------------------------------------

  it('AR-12: POST /api/admin/credentials → 405 (GET only)', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/credentials`, { method: 'POST', token: TEST_TOKEN });
    expect(r.status).toBe(405);
  });

  it('AR-13: GET /api/admin/restart → 405 (POST only)', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/restart`, { method: 'GET', token: TEST_TOKEN });
    expect(r.status).toBe(405);
  });

  it('AR-14: GET /api/admin/bogus → 404 with valid Bearer', async () => {
    const s = await startTestServer(); servers.push(s);
    const r = await rawRequest(`${s.baseUrl}/api/admin/bogus`, { token: TEST_TOKEN });
    expect(r.status).toBe(404);
  });
});
