/**
 * @file tests/api/dashboard-stats.test.ts
 * @description GET /api/admin/dashboard/stats returns real measurements
 * (sessions from mind.db, tokens/cost from knowledge.db api_costs, disk via
 * statfs) and null — never a fabricated zero — when a source is unavailable.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';

function makeReq(method: string, url: string): http.IncomingMessage {
  return { method, url, headers: {}, socket: {} } as unknown as http.IncomingMessage;
}

function makeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  const res: Record<string, unknown> = {
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (status: number) => {
      statusCode = status;
      res['headersSent'] = true;
      return res;
    },
    end: (body?: string) => {
      if (body) chunks.push(body);
    },
  };
  return {
    res: res as unknown as http.ServerResponse,
    status: () => statusCode,
    body: () => JSON.parse(chunks.join('') || 'null') as Record<string, unknown>,
  };
}

type AdminRouterT = typeof import('../../src/core/api/admin-router.js')['adminRouter'];

async function importHandlerWithDataDir(dataDir: string): Promise<AdminRouterT> {
  process.env['DATA_DIR'] = dataDir;
  vi.resetModules();
  const { adminRouter } = await import('../../src/core/api/admin-router.js');
  await import('../../src/core/api/admin/dashboard.handler.js');
  return adminRouter;
}

const sessionMeta = (id: string, state: string): string =>
  JSON.stringify({
    id,
    channel: 'web',
    peerId: 'peer-1',
    state,
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
  });

describe('GET /api/admin/dashboard/stats', () => {
  let seededDir: string;
  let emptyDir: string;
  let prevDataDir: string | undefined;

  beforeAll(() => {
    prevDataDir = process.env['DATA_DIR'];
    seededDir = mkdtempSync(path.join(os.tmpdir(), 'dash-stats-seeded-'));
    emptyDir = mkdtempSync(path.join(os.tmpdir(), 'dash-stats-empty-'));

    const mind = new Database(path.join(seededDir, 'mind.db'));
    mind.exec(`CREATE TABLE chunks (path TEXT, source TEXT, text TEXT)`);
    const ins = mind.prepare(
      `INSERT INTO chunks (path, source, text) VALUES (?, 'conversation', ?)`,
    );
    ins.run('session:s1:meta', sessionMeta('s1', 'active'));
    ins.run('session:s2:meta', sessionMeta('s2', 'archived'));
    mind.close();

    const know = new Database(path.join(seededDir, 'knowledge.db'));
    know.exec(
      `CREATE TABLE api_costs (
         provider TEXT, model TEXT, operation TEXT,
         input_tokens INTEGER, output_tokens INTEGER,
         cost_usd REAL, created_at TEXT
       )`,
    );
    const cost = know.prepare(
      `INSERT INTO api_costs
         (provider, model, operation, input_tokens, output_tokens, cost_usd, created_at)
       VALUES ('anthropic', 'm', 'completion', ?, ?, ?, ?)`,
    );
    cost.run(100, 50, 0.25, new Date().toISOString());
    cost.run(999, 999, 9.99, '2020-01-01T00:00:00.000Z'); // before today — excluded
    know.close();
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = prevDataDir;
    vi.resetModules();
    rmSync(seededDir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('DS-1: serves real session, token, cost and disk values from seeded DBs', async () => {
    const router = await importHandlerWithDataDir(seededDir);
    const { res, status, body } = makeRes();
    const handled = await router.dispatch(makeReq('GET', '/api/admin/dashboard/stats'), res);

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    const payload = body();
    expect(payload['activeSessions']).toBe(1); // s1 active, s2 archived
    expect(payload['tokensToday']).toBe(150);
    expect(payload['costToday']).toBeCloseTo(0.25);
    expect(typeof payload['cpu']).toBe('number');
    expect(typeof payload['memory']).toBe('number');
    // Linux CI: statfs on DATA_DIR succeeds
    expect(typeof payload['disk']).toBe('number');
    // The fabricated agentActivity { total: 8 } field is gone for good
    expect(payload).not.toHaveProperty('agentActivity');
  });

  it('DS-2: missing DBs yield null — unknown is not reported as zero', async () => {
    const router = await importHandlerWithDataDir(emptyDir);
    const { res, status, body } = makeRes();
    const handled = await router.dispatch(makeReq('GET', '/api/admin/dashboard/stats'), res);

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    const payload = body();
    expect(payload['activeSessions']).toBeNull();
    expect(payload['tokensToday']).toBeNull();
    expect(payload['costToday']).toBeNull();
    expect(typeof payload['cpu']).toBe('number');
  });

  it('DS-3: empty api_costs table sums to a real zero (distinct from null)', async () => {
    const zeroDir = mkdtempSync(path.join(os.tmpdir(), 'dash-stats-zero-'));
    try {
      const know = new Database(path.join(zeroDir, 'knowledge.db'));
      know.exec(
        `CREATE TABLE api_costs (
           provider TEXT, model TEXT, operation TEXT,
           input_tokens INTEGER, output_tokens INTEGER,
           cost_usd REAL, created_at TEXT
         )`,
      );
      know.close();

      const router = await importHandlerWithDataDir(zeroDir);
      const { res, body } = makeRes();
      await router.dispatch(makeReq('GET', '/api/admin/dashboard/stats'), res);
      const payload = body();
      expect(payload['tokensToday']).toBe(0);
      expect(payload['costToday']).toBe(0);
      expect(payload['activeSessions']).toBeNull(); // no mind.db in this dir
    } finally {
      rmSync(zeroDir, { recursive: true, force: true });
    }
  });
});
