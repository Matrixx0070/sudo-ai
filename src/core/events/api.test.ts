import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerEventsApi } from './api.js';
import { EventStore } from './store.js';
import { DeliveryWorker } from './worker.js';

/**
 * Auth note: gateway/auth.ts accepts loopback connections when no GATEWAY_TOKEN
 * is configured (dev posture) — these tests run against 127.0.0.1 with the
 * token envs cleared, exercising route logic; token rejection is covered by
 * the auth module's own tests.
 */
describe('events REST API', () => {
  let dir: string;
  let store: EventStore;
  let server: Server;
  let base: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = {
      GATEWAY_TOKEN: process.env['GATEWAY_TOKEN'],
      GATEWAY_SECRET: process.env['GATEWAY_SECRET'],
      SUDO_GATEWAY_UNIFIED_AUTH: process.env['SUDO_GATEWAY_UNIFIED_AUTH'],
    };
    delete process.env['GATEWAY_TOKEN'];
    delete process.env['GATEWAY_SECRET'];
    dir = mkdtempSync(join(tmpdir(), 'events-api-'));
    store = new EventStore(join(dir, 'e.db'));
    const worker = new DeliveryWorker({ store, fetchImpl: async () => new Response('ok', { status: 200 }) });
    server = createServer((_req, _res) => { /* events api listener responds */ });
    registerEventsApi(server, { store, worker });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  it('full endpoint lifecycle: create → list(masked) → patch → rotate → delete', async () => {
    const created = await call('POST', '/v1/webhook-endpoints', {
      name: 'CI notifier', url: 'https://ci.example/hook', description: 'd',
      event_types: ['message.completed', 'tool.*'], retry_max: 3,
    });
    expect(created.status).toBe(201);
    const ep = created.json.endpoint;
    expect(ep.secret).toMatch(/^whsec_/);
    expect(ep.secret.length).toBeGreaterThan(20); // revealed once in full

    const listed = await call('GET', '/v1/webhook-endpoints');
    expect(listed.json.endpoints).toHaveLength(1);
    expect(listed.json.endpoints[0].secret).toMatch(/^whsec_…/); // masked

    const patched = await call('PATCH', `/v1/webhook-endpoints/${ep.id}`, { enabled: false, retry_max: 1 });
    expect(patched.status).toBe(200);
    expect(patched.json.endpoint.enabled).toBe(false);
    expect(patched.json.endpoint.retry_max).toBe(1);

    const rotated = await call('POST', `/v1/webhook-endpoints/${ep.id}/rotate-secret`);
    expect(rotated.status).toBe(200);
    expect(rotated.json.endpoint.secret).toMatch(/^whsec_/);
    expect(rotated.json.endpoint.secret).not.toBe(ep.secret);
    expect(rotated.json.endpoint.secret_rotation_grace_until).toBeTruthy();

    const deleted = await call('DELETE', `/v1/webhook-endpoints/${ep.id}`);
    expect(deleted.status).toBe(200);
    expect((await call('GET', `/v1/webhook-endpoints/${ep.id}`)).status).toBe(404);
  });

  it('validates create input', async () => {
    expect((await call('POST', '/v1/webhook-endpoints', { name: 'x', url: 'ftp://nope', event_types: ['*'] })).status).toBe(400);
    expect((await call('POST', '/v1/webhook-endpoints', { name: 'x', url: 'https://u:p@h.example/', event_types: ['*'] })).status).toBe(400);
    expect((await call('POST', '/v1/webhook-endpoints', { name: 'x', url: 'https://h.example/', event_types: [] })).status).toBe(400);
    expect((await call('POST', '/v1/webhook-endpoints', { name: 'x', url: 'https://h.example/', event_types: ['nope.event'] })).status).toBe(400);
    expect((await call('POST', '/v1/webhook-endpoints', { name: 'x', url: 'https://h.example/', event_types: ['*'], retry_max: 99 })).status).toBe(400);
  });

  it('test-fire delivers immediately and logs the delivery', async () => {
    const ep = (await call('POST', '/v1/webhook-endpoints', { name: 'x', url: 'https://h.example/', event_types: ['*'] })).json.endpoint;
    const fired = await call('POST', `/v1/webhook-endpoints/${ep.id}/test`);
    expect(fired.status).toBe(200);
    expect(fired.json.delivery.status).toBe('succeeded');
    const dels = await call('GET', `/v1/webhook-endpoints/${ep.id}/deliveries`);
    expect(dels.json.deliveries).toHaveLength(1);
    const detail = await call('GET', `/v1/events/deliveries/${fired.json.delivery.id}`);
    expect(detail.json.attempts).toHaveLength(1);
    expect(detail.json.event.type).toBe('notification');
  });

  it('event log + catalog + stats + replay endpoints respond', async () => {
    const types = await call('GET', '/v1/events/types');
    expect(types.json.webhook_eligible).toContain('message.completed');
    const stats = await call('GET', '/v1/events/stats');
    expect(stats.json).toHaveProperty('deliveries');
    const events = await call('GET', '/v1/events?limit=5');
    expect(Array.isArray(events.json.events)).toBe(true);
    expect((await call('POST', '/v1/events/deliveries/whdel_missing/replay')).status).toBe(404);
  });

  it('serves the dashboard HTML without a token', async () => {
    const res = await fetch(`${base}/v1/events/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Sudo AI');
  });
});
