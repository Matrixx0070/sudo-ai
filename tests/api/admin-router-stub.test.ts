/**
 * @file tests/api/admin-router-stub.test.ts
 * @description AdminRouter stub behavior — unimplemented admin routes must
 * answer 501 Not Implemented, never a fake 200 ok. Real handlers registered
 * later (admin/index.ts registerAdminHandlers) override the stubs in place.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { adminRouter, sendJson } from '../../src/core/api/admin-router.js';

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

describe('AdminRouter — stub routes', () => {
  beforeEach(() => {
    delete process.env['SUDO_AI_DASHBOARD_TOKEN'];
  });

  afterEach(() => {
    // Restore stub behavior on the singleton route mutated by the override test
    adminRouter.get('/api/admin/security/credentials', async (_req, res) => {
      sendJson(res, 501, { error: { message: 'Not implemented', code: 501 }, section: 'security' });
    });
  });

  it('stubbed route answers 501 Not Implemented, not 200 ok', async () => {
    const { res, status, body } = makeRes();
    const handled = await adminRouter.dispatch(makeReq('GET', '/api/admin/security/access-log'), res);

    expect(handled).toBe(true);
    expect(status()).toBe(501);
    const payload = body();
    expect(payload['error']).toMatchObject({ message: 'Not implemented', code: 501 });
    expect(payload['status']).toBeUndefined();
  });

  it('real handler registered for the same path overrides the stub', async () => {
    adminRouter.get('/api/admin/security/credentials', async (_req, res2) => {
      sendJson(res2, 200, { credentials: [] });
    });

    const { res, status, body } = makeRes();
    const handled = await adminRouter.dispatch(makeReq('GET', '/api/admin/security/credentials'), res);

    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(body()).toEqual({ credentials: [] });
  });

  it('unregistered path falls through (dispatch returns false)', async () => {
    const { res } = makeRes();
    const handled = await adminRouter.dispatch(makeReq('GET', '/api/admin/no-such-route'), res);
    expect(handled).toBe(false);
  });
});
