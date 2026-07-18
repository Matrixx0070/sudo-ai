/**
 * @file tests/api/gw4-route-merge.test.ts
 * @description GW-4 tail: the /api/admin/* handler set is migrated under the
 * canonical /v1/admin/*, and legacy /api/admin/* becomes a 308 redirect logged
 * as deprecated. Proves: 308 with a correct Location (no redirect follow); the
 * same handler served under /v1/admin/*; no-credential PROXIED /v1/admin request
 * → 401 (fail-closed); isMigratedAdminPath never shadows the real exact
 * /v1/admin/dashboard route.
 *
 * Auth note: registerAdminApi authenticates via the unified resolver
 * (gateway-token or loopback-direct). To exercise the 401 path we present the
 * request as proxied (X-Forwarded-For) so loopback-direct trust does NOT apply.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const ENV_KEYS = ['SUDO_ADMIN_API', 'SUDO_ADMIN_API_DANGER', 'SUDO_AI_DASHBOARD_TOKEN', 'GATEWAY_TOKEN', 'DATA_DIR'] as const;
let saved: Record<string, string | undefined>;
let dir: string;
let servers: http.Server[];

function seedMindDb(): void {
  const db = new Database(path.join(dir, 'mind.db'));
  db.exec(`CREATE TABLE chunks (path TEXT, source TEXT, text TEXT)`);
  db.exec(`CREATE TABLE api_call_log (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
    total_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL, called_at TEXT
  )`);
  db.prepare(
    `INSERT INTO api_call_log (id, provider, model, total_tokens, estimated_cost_usd, called_at)
     VALUES ('c1', 'anthropic', 'm', 100, 1.5, ?)`,
  ).run(new Date().toISOString());
  db.close();
}

async function mount(): Promise<{ url: string; server: http.Server }> {
  vi.resetModules();
  const { registerAdminApi } = await import('../../src/core/api/admin/register.js');
  const server = http.createServer();
  servers.push(server);
  const mounted = await registerAdminApi(server);
  if (!mounted) throw new Error('expected mount');
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(path.join(tmpdir(), 'gw4-merge-'));
  process.env['DATA_DIR'] = dir;
  process.env['SUDO_ADMIN_API'] = '1';
  // GATEWAY_TOKEN is the credential the unified resolver actually validates.
  process.env['GATEWAY_TOKEN'] = 'secret';
  servers = [];
});

afterEach(async () => {
  for (const s of servers) { await new Promise<void>((r) => s.close(() => r())); }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('GW-4 tail — /api/admin → /v1/admin route merge', () => {
  it('legacy /api/admin/* → 308 with canonical /v1/admin Location (query preserved)', async () => {
    const { url } = await mount();
    const r = await fetch(`${url}/api/admin/dashboard/stats?x=1`, { redirect: 'manual' });
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe('/v1/admin/dashboard/stats?x=1');
  });

  it('308 preserves method for danger POST routes (no auto-exec)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));
    const { url } = await mount();
    const r = await fetch(`${url}/api/admin/service/restart`, { method: 'POST', redirect: 'manual' });
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe('/v1/admin/service/restart');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('canonical /v1/admin/* serves the migrated handler set (200 with auth)', async () => {
    seedMindDb();
    const { url } = await mount();
    const r = await fetch(`${url}/v1/admin/dashboard/stats`, { headers: { Authorization: 'Bearer secret' } });
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body['costToday']).toBeCloseTo(1.5);
  });

  it('no-credential PROXIED /v1/admin request → 401 (fail-closed at the boundary)', async () => {
    const { url } = await mount();
    // X-Forwarded-For makes the loopback socket untrustworthy → no loopback grant.
    const r = await fetch(`${url}/v1/admin/dashboard/stats`, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    expect(r.status).toBe(401);
  });

  it('wrong bearer on a PROXIED /v1/admin request → 401', async () => {
    const { url } = await mount();
    const r = await fetch(`${url}/v1/admin/dashboard/stats`, {
      headers: { Authorization: 'Bearer wrong', 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(r.status).toBe(401);
  });

  it('/v1/admin danger route honors the SUDO_ADMIN_API_DANGER gate (403 when off)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));
    const { url } = await mount();
    const r = await fetch(`${url}/v1/admin/service/restart`, { method: 'POST', headers: { Authorization: 'Bearer secret' } });
    expect(r.status).toBe(403);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('follows the 308 end-to-end (fetch default) to a 200', async () => {
    seedMindDb();
    const { url } = await mount();
    const r = await fetch(`${url}/api/admin/dashboard/stats`, { headers: { Authorization: 'Bearer secret' } });
    expect(r.status).toBe(200); // 308 → /v1/admin/... served by the same listener
  });
});

describe('GW-4 tail — isMigratedAdminPath', () => {
  it('claims the stub namespaces but never the real exact /v1/admin/dashboard', async () => {
    const { isMigratedAdminPath } = await import('../../src/core/api/admin/register.js');
    expect(isMigratedAdminPath('/v1/admin/dashboard/stats')).toBe(true);
    expect(isMigratedAdminPath('/v1/admin/models/config')).toBe(true);
    expect(isMigratedAdminPath('/v1/admin/sessions')).toBe(true);
    // real HTML dashboard (exact) must NOT be shadowed
    expect(isMigratedAdminPath('/v1/admin/dashboard')).toBe(false);
    // real audit/inspection routes must NOT be claimed
    expect(isMigratedAdminPath('/v1/admin/audit/verify')).toBe(false);
    expect(isMigratedAdminPath('/v1/admin/inspection')).toBe(false);
  });
});
