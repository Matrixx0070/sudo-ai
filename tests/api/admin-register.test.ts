/**
 * @file tests/api/admin-register.test.ts
 * @description Security contract for registerAdminApi() — the fail-closed
 * registrar that mounts /api/admin/* onto the gateway. Proves: default-OFF (no
 * listener), fail-closed when no token, Bearer auth enforced BEFORE dispatch,
 * the irreversible-route 403 gate (process.exit never reached), OPTIONS
 * preflight, and the GATEWAY_TOKEN fallback.
 *
 * Each case re-imports the registrar under vi.resetModules() so it binds a fresh
 * adminRouter singleton + the DATA_DIR captured by the handler modules.
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

/** Fresh registrar + a real listening server. Returns base url + the mount flag. */
async function mount(): Promise<{ url: string | null; mounted: boolean; server: http.Server }> {
  vi.resetModules();
  const { registerAdminApi } = await import('../../src/core/api/admin/register.js');
  const server = http.createServer();
  servers.push(server);
  const mounted = await registerAdminApi(server);
  if (!mounted) return { url: null, mounted, server };
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, mounted, server };
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(path.join(tmpdir(), 'admin-reg-'));
  process.env['DATA_DIR'] = dir;
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

describe('registerAdminApi — fail-closed admin gateway mount', () => {
  it('AR-1: flag OFF → not mounted, no request listener attached', async () => {
    const { mounted, server } = await mount();
    expect(mounted).toBe(false);
    expect(server.listenerCount('request')).toBe(0);
  });

  it('AR-2: flag ON but NO token → fail-closed (not mounted, no listener)', async () => {
    process.env['SUDO_ADMIN_API'] = '1';
    const { mounted, server } = await mount();
    expect(mounted).toBe(false);
    expect(server.listenerCount('request')).toBe(0);
  });

  it('AR-3: flag ON + token + valid Bearer → 200 real data (stub overridden)', async () => {
    seedMindDb();
    process.env['SUDO_ADMIN_API'] = '1';
    process.env['SUDO_AI_DASHBOARD_TOKEN'] = 'secret';
    const { url } = await mount();
    const r = await fetch(`${url}/api/admin/dashboard/stats`, { headers: { Authorization: 'Bearer secret' } });
    expect(r.status).toBe(200); // 501 stub would fail this
    const body = await r.json() as Record<string, unknown>;
    expect(typeof body['cpu']).toBe('number');
    expect(body['costToday']).toBeCloseTo(1.5); // from the seeded api_call_log row
  });

  it('AR-4: wrong token → 401', async () => {
    process.env['SUDO_ADMIN_API'] = '1';
    process.env['SUDO_AI_DASHBOARD_TOKEN'] = 'secret';
    const { url } = await mount();
    const r = await fetch(`${url}/api/admin/dashboard/stats`, { headers: { Authorization: 'Bearer wrong' } });
    expect(r.status).toBe(401);
  });

  it('AR-5: no Authorization header → 401', async () => {
    process.env['SUDO_ADMIN_API'] = '1';
    process.env['SUDO_AI_DASHBOARD_TOKEN'] = 'secret';
    const { url } = await mount();
    const r = await fetch(`${url}/api/admin/dashboard/stats`);
    expect(r.status).toBe(401);
  });

  it('AR-6: OPTIONS preflight → 204 without auth and never triggers a danger handler', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));
    process.env['SUDO_ADMIN_API'] = '1';
    process.env['SUDO_ADMIN_API_DANGER'] = '1';
    process.env['SUDO_AI_DASHBOARD_TOKEN'] = 'secret';
    const { url } = await mount();
    // OPTIONS bypasses auth (CORS preflight) — prove it still cannot reach the restart handler.
    const r = await fetch(`${url}/api/admin/service/restart`, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('AR-7: danger route (restart) with valid token but danger OFF → 403, process.exit NOT called', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));
    process.env['SUDO_ADMIN_API'] = '1';
    process.env['SUDO_AI_DASHBOARD_TOKEN'] = 'secret';
    // SUDO_ADMIN_API_DANGER intentionally unset
    const { url } = await mount();
    const r = await fetch(`${url}/api/admin/service/restart`, { method: 'POST', headers: { Authorization: 'Bearer secret' } });
    expect(r.status).toBe(403);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('AR-8: danger route without auth → 401, process.exit NOT called', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));
    process.env['SUDO_ADMIN_API'] = '1';
    process.env['SUDO_ADMIN_API_DANGER'] = '1'; // even with danger on, auth must gate first
    process.env['SUDO_AI_DASHBOARD_TOKEN'] = 'secret';
    const { url } = await mount();
    const r = await fetch(`${url}/api/admin/service/restart`, { method: 'POST' });
    expect(r.status).toBe(401);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('AR-9: GATEWAY_TOKEN fallback authenticates when SUDO_AI_DASHBOARD_TOKEN unset', async () => {
    seedMindDb();
    process.env['SUDO_ADMIN_API'] = '1';
    process.env['GATEWAY_TOKEN'] = 'gw-tok';
    const { url } = await mount();
    const r = await fetch(`${url}/api/admin/dashboard/stats`, { headers: { Authorization: 'Bearer gw-tok' } });
    expect(r.status).toBe(200);
  });

  it('AR-10: DANGER=1 + valid token reaches the restart handler (danger gate opened)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));
    process.env['SUDO_ADMIN_API'] = '1';
    process.env['SUDO_ADMIN_API_DANGER'] = '1';
    process.env['SUDO_AI_DASHBOARD_TOKEN'] = 'secret';
    const { url } = await mount();
    const r = await fetch(`${url}/api/admin/service/restart`, { method: 'POST', headers: { Authorization: 'Bearer secret' } });
    expect(r.status).toBe(200); // reached the handler — NOT the 403 danger gate
    // The handler acks 200 then schedules process.exit(0) ~500ms later.
    await new Promise((res) => setTimeout(res, 700));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
