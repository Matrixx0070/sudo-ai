/**
 * @file tests/gateway/federation-routes.test.ts
 * @description Federation REST route tests — Wave 7E.
 *
 * Tests:
 *   FED-ROUTE-1   POST /ingest — 401 with no inbound tokens configured
 *   FED-ROUTE-2   POST /ingest — 401 with wrong token
 *   FED-ROUTE-3   POST /ingest — 400 with no body
 *   FED-ROUTE-4   POST /ingest — 400 with invalid JSON
 *   FED-ROUTE-5   POST /ingest — 400 missing instanceId
 *   FED-ROUTE-6   POST /ingest — 400 missing eventType
 *   FED-ROUTE-7   POST /ingest — 400 invalid ts
 *   FED-ROUTE-8   POST /ingest — 400 invalid seq
 *   FED-ROUTE-9   POST /ingest — 200 valid event stored
 *   FED-ROUTE-10  POST /ingest — 409 on duplicate
 *   FED-ROUTE-11  GET  /tail  — 401 with no inbound tokens configured
 *   FED-ROUTE-12  GET  /tail  — 200 with empty events
 *   FED-ROUTE-13  GET  /tail  — 400 for invalid since param
 *   FED-ROUTE-14  GET  /peers — 401 with wrong admin token
 *   FED-ROUTE-15  GET  /peers — 200 with configured peers (no tokens)
 *   FED-ROUTE-16  GET  /peers — 200 with empty peers when none configured
 *   FED-ROUTE-17  GET  /stats — 401 with wrong admin token
 *   FED-ROUTE-18  GET  /stats — 200 with correct stat fields
 *   FED-ROUTE-19  GET  /v1/federation/unknown — 404
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { registerFederationRoutes, type FederationRoutesDeps } from '../../src/core/gateway/federation-routes.js';
import { PeerRegistry } from '../../src/core/federation/peer-registry.js';
import { AuditChainSync } from '../../src/core/federation/audit-chain-sync.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'test-admin-token-fed';
const INBOUND_TOKEN = 'sk_inbound_test_123';
const INSTANCE_ID = 'test-instance-fed';

function makeAdminTokenBuf(): Buffer {
  return Buffer.from(ADMIN_TOKEN, 'utf8');
}

function makeInMemoryDb(): ReturnType<typeof Database> {
  return new Database(':memory:');
}

function makeDeps(opts?: {
  inboundToken?: string;
  peers?: Array<{ name: string; url: string; token: string }>;
}): FederationRoutesDeps {
  const inboundTokens = opts?.inboundToken
    ? JSON.stringify([opts.inboundToken])
    : undefined;
  const peersJson = opts?.peers ? JSON.stringify(opts.peers) : undefined;

  const peerRegistry = new PeerRegistry(peersJson, inboundTokens);
  const db = makeInMemoryDb();
  const auditChainSync = new AuditChainSync(db, peerRegistry, INSTANCE_ID);
  return { peerRegistry, auditChainSync };
}

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

function startServer(deps: FederationRoutesDeps, adminTokenBuf: Buffer | null): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    registerFederationRoutes(server, deps, adminTokenBuf);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const close = (): Promise<void> =>
        new Promise((res, rej) => server.close((err) => (err ? rej(err) : res())));
      resolve({ baseUrl, close });
    });
    server.on('error', reject);
  });
}

async function doPost(url: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: resp.status, json: await resp.json() };
}

async function doPostRaw(url: string, rawBody: string, token?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { method: 'POST', headers, body: rawBody });
  return { status: resp.status, json: await resp.json() };
}

async function doGet(url: string, token?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { method: 'GET', headers });
  return { status: resp.status, json: await resp.json() };
}

// ---------------------------------------------------------------------------
// POST /v1/federation/audit/ingest
// ---------------------------------------------------------------------------
describe('POST /v1/federation/audit/ingest', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  it('FED-ROUTE-1: 401 with no inbound tokens configured', async () => {
    ts = await startServer(makeDeps(), makeAdminTokenBuf());
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/audit/ingest`, {}, INBOUND_TOKEN);
    expect(status).toBe(401);
  });

  it('FED-ROUTE-2: 401 with wrong inbound token', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const { status } = await doPost(`${ts.baseUrl}/v1/federation/audit/ingest`, {}, 'sk_wrong_token');
    expect(status).toBe(401);
  });

  it('FED-ROUTE-3: 400 with no body', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const { status } = await doPostRaw(`${ts.baseUrl}/v1/federation/audit/ingest`, '', INBOUND_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ROUTE-4: 400 with invalid JSON', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const { status } = await doPostRaw(`${ts.baseUrl}/v1/federation/audit/ingest`, 'not-json', INBOUND_TOKEN);
    expect(status).toBe(400);
  });

  it('FED-ROUTE-5: 400 missing instanceId', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const { status } = await doPost(
      `${ts.baseUrl}/v1/federation/audit/ingest`,
      { eventType: 're-anchor', payload: {}, ts: Date.now(), seq: 1 },
      INBOUND_TOKEN,
    );
    expect(status).toBe(400);
  });

  it('FED-ROUTE-6: 400 missing eventType', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const { status } = await doPost(
      `${ts.baseUrl}/v1/federation/audit/ingest`,
      { instanceId: 'remote', payload: {}, ts: Date.now(), seq: 1 },
      INBOUND_TOKEN,
    );
    expect(status).toBe(400);
  });

  it('FED-ROUTE-7: 400 invalid ts (zero)', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const { status } = await doPost(
      `${ts.baseUrl}/v1/federation/audit/ingest`,
      { instanceId: 'remote', eventType: 'test', payload: {}, ts: 0, seq: 1 },
      INBOUND_TOKEN,
    );
    expect(status).toBe(400);
  });

  it('FED-ROUTE-8: 400 invalid seq (zero)', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const { status } = await doPost(
      `${ts.baseUrl}/v1/federation/audit/ingest`,
      { instanceId: 'remote', eventType: 'test', payload: {}, ts: Date.now(), seq: 0 },
      INBOUND_TOKEN,
    );
    expect(status).toBe(400);
  });

  it('FED-ROUTE-9: 200 valid event stored', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const { status, json } = await doPost(
      `${ts.baseUrl}/v1/federation/audit/ingest`,
      {
        id: 'test-evt-001',
        instanceId: 'remote-instance',
        eventType: 're-anchor',
        payload: { trigger: 'post-veto' },
        ts: Date.now(),
        seq: 1,
      },
      INBOUND_TOKEN,
    );
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('test-evt-001');
  });

  it('FED-ROUTE-10: 409 on duplicate instanceId+seq', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const event = {
      id: 'test-evt-dup',
      instanceId: 'remote-dup',
      eventType: 'test',
      payload: {},
      ts: Date.now(),
      seq: 5,
    };
    const first = await doPost(`${ts.baseUrl}/v1/federation/audit/ingest`, event, INBOUND_TOKEN);
    expect(first.status).toBe(200);
    const second = await doPost(`${ts.baseUrl}/v1/federation/audit/ingest`, { ...event, id: 'dup-id' }, INBOUND_TOKEN);
    expect(second.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/federation/audit/tail
// ---------------------------------------------------------------------------
describe('GET /v1/federation/audit/tail', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  it('FED-ROUTE-11: 401 with no inbound tokens configured', async () => {
    ts = await startServer(makeDeps(), makeAdminTokenBuf());
    const { status } = await doGet(`${ts.baseUrl}/v1/federation/audit/tail`, INBOUND_TOKEN);
    expect(status).toBe(401);
  });

  it('FED-ROUTE-12: 200 with empty events when no data', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const { status, json } = await doGet(`${ts.baseUrl}/v1/federation/audit/tail?since=0`, INBOUND_TOKEN);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { events: unknown[]; count: number } };
    expect(body.ok).toBe(true);
    expect(body.data.events).toEqual([]);
    expect(body.data.count).toBe(0);
  });

  it('FED-ROUTE-13: 400 for invalid since param (negative)', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const { status } = await doGet(`${ts.baseUrl}/v1/federation/audit/tail?since=-1`, INBOUND_TOKEN);
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/federation/peers
// ---------------------------------------------------------------------------
describe('GET /v1/federation/peers', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  it('FED-ROUTE-14: 401 with wrong admin token', async () => {
    ts = await startServer(makeDeps(), makeAdminTokenBuf());
    const { status } = await doGet(`${ts.baseUrl}/v1/federation/peers`, 'wrong-admin-token');
    expect(status).toBe(401);
  });

  it('FED-ROUTE-15: 200 with configured peers (no tokens in response)', async () => {
    const peers = [{ name: 'peer-a', url: 'https://peer-a.example.com:18900', token: 'sk_secret' }];
    ts = await startServer(makeDeps({ peers }), makeAdminTokenBuf());
    const { status, json } = await doGet(`${ts.baseUrl}/v1/federation/peers`, ADMIN_TOKEN);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { peers: Array<{ name: string; url: string; token?: string }> } };
    expect(body.ok).toBe(true);
    expect(body.data.peers).toHaveLength(1);
    expect(body.data.peers[0]!.name).toBe('peer-a');
    // Token must NOT be returned
    expect(body.data.peers[0]).not.toHaveProperty('token');
  });

  it('FED-ROUTE-16: 200 with empty peers when none configured', async () => {
    ts = await startServer(makeDeps(), makeAdminTokenBuf());
    const { status, json } = await doGet(`${ts.baseUrl}/v1/federation/peers`, ADMIN_TOKEN);
    expect(status).toBe(200);
    const body = json as { ok: boolean; data: { peers: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data.peers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/federation/stats
// ---------------------------------------------------------------------------
describe('GET /v1/federation/stats', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  it('FED-ROUTE-17: 401 with wrong admin token', async () => {
    ts = await startServer(makeDeps(), makeAdminTokenBuf());
    const { status } = await doGet(`${ts.baseUrl}/v1/federation/stats`, 'wrong-token');
    expect(status).toBe(401);
  });

  it('FED-ROUTE-18: 200 with correct stat fields (empty state)', async () => {
    ts = await startServer(makeDeps(), makeAdminTokenBuf());
    const { status, json } = await doGet(`${ts.baseUrl}/v1/federation/stats`, ADMIN_TOKEN);
    expect(status).toBe(200);
    const body = json as {
      ok: boolean;
      data: {
        outboundSeq: number;
        inboundEventCount: number;
        peersConfigured: number;
        lastInboundTs: null;
        lastOutboundTs: null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.outboundSeq).toBe(0);
    expect(body.data.inboundEventCount).toBe(0);
    expect(body.data.peersConfigured).toBe(0);
    expect(body.data.lastInboundTs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FED-ROUTE-19: 404 for unknown federation path
// ---------------------------------------------------------------------------
describe('Unknown federation paths', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts?.close();
  });

  it('FED-ROUTE-19: 404 for unrecognised /v1/federation/* path', async () => {
    ts = await startServer(makeDeps({ inboundToken: INBOUND_TOKEN }), makeAdminTokenBuf());
    const { status } = await doGet(`${ts.baseUrl}/v1/federation/unknown-path`, INBOUND_TOKEN);
    expect(status).toBe(404);
  });
});
