/**
 * @file Regression test: a second 'request' listener on the shared gateway
 * server must not crash the process when the response was already written.
 *
 * Live incident 2026-07-04: a dashboard poll of GET /v1/admin/claude-oauth/status
 * hit a path where another listener had already responded; the oauth router's
 * sendJson then called writeHead → ERR_HTTP_HEADERS_SENT → uncaughtException →
 * full daemon shutdown. sendJson now skips when headers are already sent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerAdminClaudeOAuthRoutes } from '../../../src/core/gateway/admin-claude-oauth-routes.js';

describe('admin-claude-oauth routes — shared-server listener collision', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function startServer(preListener: http.RequestListener): Promise<number> {
    server = http.createServer();
    // A listener registered BEFORE the oauth router that always responds —
    // simulates the main gateway dispatch having already written.
    server.on('request', preListener);
    registerAdminClaudeOAuthRoutes(server, null);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return (server!.address() as AddressInfo).port;
  }

  it('does not throw ERR_HTTP_HEADERS_SENT when another listener already responded', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ from: 'main-dispatch' }));
    });

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/admin/claude-oauth/status`);
      const body = (await res.json()) as { from?: string };
      // First writer wins; the oauth router must silently stand down.
      expect(res.status).toBe(200);
      expect(body.from).toBe('main-dispatch');
      // Give any escaped throw a tick to surface.
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toHaveLength(0);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('still serves status normally when no other listener responded', async () => {
    const port = await startServer(() => {
      /* main dispatch ignores /v1/admin/claude-oauth/* — the normal case */
    });

    const res = await fetch(`http://127.0.0.1:${port}/v1/admin/claude-oauth/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });
});
