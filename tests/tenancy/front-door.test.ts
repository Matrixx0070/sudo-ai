/**
 * Stage 2 front-door reverse-proxy tests. Uses real loopback http servers on
 * ephemeral ports (CI-safe, no external network): a mock upstream stands in for a
 * tenant instance, a real TenantManager provisions the tenant (pinned to the mock's
 * port via portRange), and the TenantFrontDoor proxies to it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { TenantManager } from '../../src/core/tenancy/tenant-manager.js';
import { TenantFrontDoor } from '../../src/core/tenancy/front-door.js';
import type { Tenant, TenantLauncher } from '../../src/core/tenancy/types.js';

const mockLauncher: TenantLauncher = {
  spawn: async () => 4242,
  stop: async () => {},
  isAlive: () => true,
};

/** Minimal HTTP client → { status, headers, body }. */
function request(
  opts: http.RequestOptions,
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const a = server.address();
    resolve(typeof a === 'object' && a ? a.port : 0);
  }));
}

describe('TenantFrontDoor', () => {
  let cpDir: string;
  let codeRoot: string;
  let upstream: http.Server;
  let upstreamPort: number;
  let manager: TenantManager;
  let frontDoor: TenantFrontDoor;
  let tenant: Tenant;
  // What the mock upstream last received + how it should respond.
  let recv: { auth?: string | string[]; path?: string; body: string; hit: boolean };
  let upstreamHandler: (req: IncomingMessage, res: ServerResponse, body: string) => void;

  beforeEach(async () => {
    cpDir = mkdtempSync(path.join(tmpdir(), 'fd-cp-'));
    codeRoot = mkdtempSync(path.join(tmpdir(), 'fd-code-'));
    mkdirSync(path.join(codeRoot, 'src'));
    writeFileSync(path.join(codeRoot, 'package.json'), '{}');

    recv = { body: '', hit: false };
    upstreamHandler = (_req, res, _body) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('UPSTREAM_OK'); };

    upstream = http.createServer((req, res) => {
      recv.hit = true;
      recv.auth = req.headers['authorization'];
      recv.path = req.url;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => { recv.body = Buffer.concat(chunks).toString('utf8'); upstreamHandler(req, res, recv.body); });
    });
    upstreamPort = await listen(upstream);

    // Real manager, port pinned to the mock upstream so the proxy reaches it.
    manager = new TenantManager({
      controlPlaneDir: cpDir,
      sharedCodeRoot: codeRoot,
      portRange: [upstreamPort, upstreamPort],
      launcher: mockLauncher,
    });
    tenant = manager.createTenant({ name: 'acme', dailyBudgetUsd: 5 });
    await manager.start(tenant.id);            // status → 'running'
    tenant = manager.get(tenant.id)!;

    frontDoor = new TenantFrontDoor({ manager, port: 0, host: '127.0.0.1', maxBodyBytes: 1024 });
    await frontDoor.start();
  });

  afterEach(async () => {
    await frontDoor.stop();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(cpDir, { recursive: true, force: true });
    rmSync(codeRoot, { recursive: true, force: true });
  });

  const fdPort = () => frontDoor.address()!;

  it('createTenant generates a userKey distinct from the internal token', () => {
    expect(typeof tenant.userKey).toBe('string');
    expect(tenant.userKey.length).toBeGreaterThanOrEqual(24);
    expect(tenant.userKey).not.toBe(tenant.token);
  });

  it('valid userKey → proxies, injects the INTERNAL token, forwards path+body, streams response', async () => {
    const res = await request(
      { host: '127.0.0.1', port: fdPort(), method: 'POST', path: '/v1/chat/completions', headers: { authorization: `Bearer ${tenant.userKey}`, 'content-type': 'application/json' } },
      '{"hello":"world"}',
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe('UPSTREAM_OK');
    expect(recv.hit).toBe(true);
    // The upstream must receive the INTERNAL token, NOT the user's key.
    expect(recv.auth).toBe(`Bearer ${tenant.token}`);
    expect(recv.auth).not.toBe(`Bearer ${tenant.userKey}`);
    expect(recv.path).toBe('/v1/chat/completions');
    expect(recv.body).toBe('{"hello":"world"}');
  });

  it('client response never contains the internal token', async () => {
    upstreamHandler = (_req, res) => { res.writeHead(200); res.end('ok'); };
    const res = await request(
      { host: '127.0.0.1', port: fdPort(), method: 'GET', path: '/health', headers: { authorization: `Bearer ${tenant.userKey}` } },
    );
    const haystack = res.body + JSON.stringify(res.headers);
    expect(haystack).not.toContain(tenant.token);
  });

  it('missing credential → 401 and upstream is not hit', async () => {
    const res = await request({ host: '127.0.0.1', port: fdPort(), method: 'GET', path: '/x', headers: {} });
    expect(res.status).toBe(401);
    expect(recv.hit).toBe(false);
  });

  it('wrong credential → 401 and upstream is not hit', async () => {
    const res = await request({ host: '127.0.0.1', port: fdPort(), method: 'GET', path: '/x', headers: { authorization: 'Bearer not-a-real-key-aaaaaaaaaaaa' } });
    expect(res.status).toBe(401);
    expect(recv.hit).toBe(false);
  });

  it('stopped tenant → 503', async () => {
    await manager.stop(tenant.id); // status → 'stopped'
    const res = await request({ host: '127.0.0.1', port: fdPort(), method: 'GET', path: '/x', headers: { authorization: `Bearer ${tenant.userKey}` } });
    expect(res.status).toBe(503);
    expect(recv.hit).toBe(false);
  });

  it('body over maxBodyBytes → 413', async () => {
    const big = 'x'.repeat(2048); // > maxBodyBytes (1024)
    const res = await request(
      { host: '127.0.0.1', port: fdPort(), method: 'POST', path: '/x', headers: { authorization: `Bearer ${tenant.userKey}`, 'content-type': 'text/plain' } },
      big,
    );
    expect(res.status).toBe(413);
  });

  it('streaming/chunked upstream response is passed through intact', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: a\n\n');
      res.write('data: b\n\n');
      res.write('data: c\n\n');
      res.end();
    };
    const res = await request(
      { host: '127.0.0.1', port: fdPort(), method: 'GET', path: '/stream', headers: { authorization: `Bearer ${tenant.userKey}` } },
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe('data: a\n\ndata: b\n\ndata: c\n\n');
  });

  it('resolveTenant is exact (a prefix of a valid key does not match)', () => {
    expect(frontDoor.resolveTenant(tenant.userKey)?.id).toBe(tenant.id);
    expect(frontDoor.resolveTenant(tenant.userKey.slice(0, -1))).toBeNull();
    expect(frontDoor.resolveTenant('')).toBeNull();
  });
});
