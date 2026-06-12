/**
 * @file tests/api/admin-stub-honesty.test.ts
 * @description H3 honesty fix — admin endpoints that perform no action must
 * answer 501, never `ok: true` with a "queued" message (PR #76 precedent).
 * Covers POST /api/admin/cron/jobs/:id/run and POST /api/admin/channels/:type/test.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

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

describe('admin stub honesty — unwired actions answer 501', () => {
  let tmpDir: string;
  let prevDataDir: string | undefined;
  let router: AdminRouterT;

  beforeAll(async () => {
    prevDataDir = process.env['DATA_DIR'];
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'admin-stub-honesty-'));
    mkdirSync(path.join(tmpDir, 'cron'), { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'cron', 'jobs.json'),
      JSON.stringify([
        {
          id: 'job-1',
          name: 'nightly-job',
          schedule: { kind: 'cron', expr: '0 3 * * *' },
          payload: { kind: 'prompt', prompt: 'noop' },
          sessionTarget: 'isolated',
          enabled: true,
          consecutiveErrors: 0,
        },
      ]),
    );

    process.env['DATA_DIR'] = tmpDir;
    vi.resetModules();
    ({ adminRouter: router } = await import('../../src/core/api/admin-router.js'));
    await import('../../src/core/api/admin/cron.handler.js');
    await import('../../src/core/api/admin/channels.handler.js');
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = prevDataDir;
    vi.resetModules();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('SH-1: cron manual run answers 501 — no scheduler is wired, the job is not run', async () => {
    const { res, status, body } = makeRes();
    const handled = await router.dispatch(
      makeReq('POST', '/api/admin/cron/jobs/job-1/run'),
      res,
    );

    expect(handled).toBe(true);
    expect(status()).toBe(501);
    const payload = body();
    expect(payload['ok']).toBeUndefined();
    expect(payload['error']).toMatchObject({ code: 501 });
    expect(String((payload['error'] as Record<string, unknown>)['message'])).toContain('not run');
  });

  it('SH-2: cron manual run still answers 404 for an unknown job', async () => {
    const { res, status } = makeRes();
    await router.dispatch(makeReq('POST', '/api/admin/cron/jobs/no-such-job/run'), res);
    expect(status()).toBe(404);
  });

  it('SH-3: channel test answers 501 — no adapter is wired, no message is sent', async () => {
    const { res, status, body } = makeRes();
    const handled = await router.dispatch(makeReq('POST', '/api/admin/channels/web/test'), res);

    expect(handled).toBe(true);
    expect(status()).toBe(501);
    const payload = body();
    expect(payload['ok']).toBeUndefined();
    expect(payload['error']).toMatchObject({ code: 501 });
    expect(String((payload['error'] as Record<string, unknown>)['message'])).toContain(
      'no test message was sent',
    );
  });

  it('SH-4: channel test still answers 400 for an unknown channel type', async () => {
    const { res, status } = makeRes();
    await router.dispatch(makeReq('POST', '/api/admin/channels/carrier-pigeon/test'), res);
    expect(status()).toBe(400);
  });
});
