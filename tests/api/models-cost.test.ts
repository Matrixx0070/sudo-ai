/**
 * @file tests/api/models-cost.test.ts
 * @description GET /api/admin/models/cost rolls up real spend from mind.db
 * api_call_log (grouped by provider), and returns the placeholder
 * (source:'placeholder') when the table is unavailable — never fabricated
 * numbers. Pins the fix that repointed this endpoint off the never-populated
 * knowledge.db api_costs table.
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
  await import('../../src/core/api/admin/models.handler.js');
  return adminRouter;
}

interface CostRecord { provider: string; total_usd: number; request_count: number }

describe('GET /api/admin/models/cost', () => {
  let seededDir: string;
  let emptyDir: string;
  let prevDataDir: string | undefined;

  beforeAll(() => {
    prevDataDir = process.env['DATA_DIR'];
    seededDir = mkdtempSync(path.join(os.tmpdir(), 'models-cost-seeded-'));
    emptyDir = mkdtempSync(path.join(os.tmpdir(), 'models-cost-empty-'));

    const mind = new Database(path.join(seededDir, 'mind.db'));
    // Mirror the real api_call_log DDL (incl. total_tokens NOT NULL) so the
    // in-test schema can't drift from cost-tracker.ts.
    mind.exec(
      `CREATE TABLE api_call_log (
         id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
         total_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL, called_at TEXT
       )`,
    );
    const ins = mind.prepare(
      `INSERT INTO api_call_log (id, provider, model, total_tokens, estimated_cost_usd, called_at)
       VALUES (?, ?, 'm', ?, ?, ?)`,
    );
    const today = new Date().toISOString();
    ins.run('a1', 'anthropic', 120, 0.2, today);
    ins.run('a2', 'anthropic', 80, 0.05, today);
    ins.run('o1', 'openai', 50, 0.1, today);
    mind.close();
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = prevDataDir;
    vi.resetModules();
    rmSync(seededDir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('MC-1: rolls up today spend by provider from api_call_log, source=database', async () => {
    const router = await importHandlerWithDataDir(seededDir);
    const { res, status, body } = makeRes();
    const handled = await router.dispatch(makeReq('GET', '/api/admin/models/cost'), res);

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    const data = body()['data'] as { today: CostRecord[]; source: string };
    expect(data.source).toBe('database');
    // anthropic ($0.25, 2 calls) outranks openai ($0.10, 1 call); sorted desc.
    expect(data.today).toHaveLength(2);
    expect(data.today[0]).toMatchObject({ provider: 'anthropic', request_count: 2 });
    expect(data.today[0]!.total_usd).toBeCloseTo(0.25);
    expect(data.today[1]).toMatchObject({ provider: 'openai', request_count: 1 });
  });

  it('MC-2: missing api_call_log table yields the placeholder, not fabricated data', async () => {
    const router = await importHandlerWithDataDir(emptyDir);
    const { res, status, body } = makeRes();
    await router.dispatch(makeReq('GET', '/api/admin/models/cost'), res);

    expect(status()).toBe(200);
    const data = body()['data'] as { today: CostRecord[]; source: string };
    expect(data.source).toBe('placeholder');
    expect(data.today).toEqual([]);
  });
});
