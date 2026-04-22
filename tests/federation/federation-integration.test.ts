/**
 * @file tests/federation/federation-integration.test.ts
 * @description Integration tests proving two SUDO-AI v5 instances can cross-publish
 * audit events via the federation protocol.
 *
 * Strategy:
 *   - Spin up two independent in-process HTTP servers, each with their own
 *     in-memory SQLite DB, PeerRegistry, and AuditChainSync.
 *   - Instance A is configured with B as an outbound peer.
 *   - Instance B is configured to accept inbound events from A (inbound bearer).
 *   - publishEvent is fire-and-forget, so all assertions use a waitFor poll helper.
 *
 * Tests:
 *   FED-INT-01  Successful A→B handshake: event appears on B's inbound table
 *   FED-INT-02  Wrong inbound bearer on B → 401 on direct ingest
 *   FED-INT-03  After wrong-bearer ingest attempt, B's inboundEventCount stays 0
 *   FED-INT-04  Duplicate seq ingest on B → 409 idempotent response
 *   FED-INT-05  A's outbound seq increments even when peer has wrong token (fire-and-forget)
 *   FED-INT-06  Missing peer in registry → fetchPeerTail returns []
 *   FED-INT-07  Peer unreachable (port not listening) → publishEvent is non-fatal, seq increments
 *   FED-INT-08  Tail pagination: since=0 returns all; since=future returns none
 *   FED-INT-09  B fetches A's audit tail via fetchPeerTail (bidirectional read)
 *   FED-INT-10  Malformed event body → 400 from ingest endpoint
 *   FED-INT-11  Multiple events from A accumulate on B
 *   FED-INT-12  Stats endpoint on B reflects inbound count after handshake
 *
 * Wave 8C — federation cross-instance handshake proof.
 */

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { PeerRegistry } from '../../src/core/federation/peer-registry.js';
import { AuditChainSync } from '../../src/core/federation/audit-chain-sync.js';
import { registerFederationRoutes } from '../../src/core/gateway/federation-routes.js';
import type { FederationRoutesDeps } from '../../src/core/gateway/federation-routes.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bearer token A presents when posting to B's ingest endpoint. */
const TOKEN_A_TO_B = 'fed_tok_a_to_b_test';
/** Bearer token B presents when posting to A's ingest endpoint. */
const TOKEN_B_TO_A = 'fed_tok_b_to_a_test';

const ADMIN_TOKEN = 'admin_test_token_int';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Polls `predicate()` every 40 ms until it returns true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 40));
  }
  return false;
}

interface FedServer {
  baseUrl: string;
  sync: AuditChainSync;
  close(): Promise<void>;
}

/** Start an isolated federation server with its own in-memory DB. */
function startFedServer(opts: {
  instanceId: string;
  /** Outbound peers this instance will publish to. */
  peersJson?: string;
  /** Inbound bearer tokens this instance accepts. */
  inboundTokensJson?: string;
}): Promise<FedServer> {
  return new Promise((resolve, reject) => {
    const db = new Database(':memory:');
    const registry = new PeerRegistry(opts.peersJson, opts.inboundTokensJson);
    const sync = new AuditChainSync(db, registry, opts.instanceId);

    const deps: FederationRoutesDeps = { peerRegistry: registry, auditChainSync: sync };
    const adminBuf = Buffer.from(ADMIN_TOKEN, 'utf8');

    const server = http.createServer();
    registerFederationRoutes(server, deps, adminBuf);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const close = (): Promise<void> =>
        new Promise((res, rej) => server.close(err => (err ? rej(err) : res())));
      resolve({ baseUrl, sync, close });
    });
    server.on('error', reject);
  });
}

/** Convenience: POST JSON to a URL with optional bearer token. */
async function post(url: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: await resp.json() };
}

/** Convenience: GET a URL with optional bearer token. */
async function get(url: string, token?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { method: 'GET', headers });
  return { status: resp.status, json: await resp.json() };
}

// ---------------------------------------------------------------------------
// Per-test server lifecycle — each test gets fresh instances
// ---------------------------------------------------------------------------

let serverA: FedServer | null = null;
let serverB: FedServer | null = null;

afterEach(async () => {
  await serverA?.close().catch(() => undefined);
  await serverB?.close().catch(() => undefined);
  serverA = null;
  serverB = null;
});

afterAll(async () => {
  // Belt-and-suspenders cleanup
  await serverA?.close().catch(() => undefined);
  await serverB?.close().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Federation cross-instance handshake', () => {
  // -------------------------------------------------------------------------
  // FED-INT-01: core handshake — A publishes, B ingests
  // -------------------------------------------------------------------------
  it('FED-INT-01: A→B handshake: event appears on B inbound table', async () => {
    // Step 1: Start B without knowing A's URL — B only needs an inbound token.
    serverB = await startFedServer({
      instanceId: 'b',
      inboundTokensJson: JSON.stringify([TOKEN_A_TO_B]),
      // B also knows A as a peer (for bidirectional, but not required for this test)
    });

    // Step 2: Start A with B as an outbound peer using B's real port.
    const peersForA = JSON.stringify([
      { name: 'b', url: serverB.baseUrl, token: TOKEN_A_TO_B },
    ]);
    serverA = await startFedServer({
      instanceId: 'a',
      peersJson: peersForA,
      inboundTokensJson: JSON.stringify([TOKEN_B_TO_A]),
    });

    // Step 3: A publishes an event — fire-and-forget.
    serverA.sync.publishEvent('test-event', { wave: '8C', purpose: 'handshake-proof' });

    // Step 4: Poll B until the event arrives (max 2 s).
    const arrived = await waitFor(() => serverB!.sync.getInboundEventCount() > 0);
    expect(arrived).toBe(true);

    // Step 5: Verify the event content.
    const events = serverB.sync.queryInboundTail(0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]!.instanceId).toBe('a');
    expect(events[0]!.eventType).toBe('test-event');
    expect(events[0]!.payload).toMatchObject({ wave: '8C', purpose: 'handshake-proof' });
    expect(events[0]!.seq).toBe(1);
  });

  // -------------------------------------------------------------------------
  // FED-INT-02: wrong inbound bearer → 401
  // -------------------------------------------------------------------------
  it('FED-INT-02: wrong inbound bearer on B → 401', async () => {
    serverB = await startFedServer({
      instanceId: 'b',
      inboundTokensJson: JSON.stringify([TOKEN_A_TO_B]),
    });

    const { status } = await post(
      `${serverB.baseUrl}/v1/federation/audit/ingest`,
      { instanceId: 'a', eventType: 'test', payload: {}, ts: Date.now(), seq: 1 },
      'sk_completely_wrong_token',
    );
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // FED-INT-03: After 401 rejection, B's inbound count stays 0
  // -------------------------------------------------------------------------
  it('FED-INT-03: rejected event does not appear on B inbound table', async () => {
    serverB = await startFedServer({
      instanceId: 'b',
      inboundTokensJson: JSON.stringify([TOKEN_A_TO_B]),
    });

    // Attempt ingest with wrong token — should be rejected.
    await post(
      `${serverB.baseUrl}/v1/federation/audit/ingest`,
      { instanceId: 'a', eventType: 'test', payload: {}, ts: Date.now(), seq: 1 },
      'bad_token',
    );

    // B's count must remain 0.
    expect(serverB.sync.getInboundEventCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // FED-INT-04: duplicate seq → 409 idempotent
  // -------------------------------------------------------------------------
  it('FED-INT-04: duplicate (instanceId, seq) on B → 409', async () => {
    serverB = await startFedServer({
      instanceId: 'b',
      inboundTokensJson: JSON.stringify([TOKEN_A_TO_B]),
    });

    const envelope = {
      id: 'unique-id-dup-test',
      instanceId: 'a',
      eventType: 'dup-event',
      payload: { x: 1 },
      ts: Date.now(),
      seq: 42,
    };

    // First ingest — must succeed with 200.
    const first = await post(
      `${serverB.baseUrl}/v1/federation/audit/ingest`,
      envelope,
      TOKEN_A_TO_B,
    );
    expect(first.status).toBe(200);

    // Second ingest of same (instanceId, seq) — must return 409.
    const second = await post(
      `${serverB.baseUrl}/v1/federation/audit/ingest`,
      envelope,
      TOKEN_A_TO_B,
    );
    expect(second.status).toBe(409);

    // B still has exactly 1 event (idempotent — no double-count).
    expect(serverB.sync.getInboundEventCount()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // FED-INT-05: wrong-token peer — A's outbound seq still increments
  // -------------------------------------------------------------------------
  it('FED-INT-05: A seq increments even if B rejects with wrong bearer', async () => {
    // B accepts TOKEN_A_TO_B but A will use the wrong token.
    serverB = await startFedServer({
      instanceId: 'b',
      inboundTokensJson: JSON.stringify([TOKEN_A_TO_B]),
    });

    const peersForA = JSON.stringify([
      { name: 'b', url: serverB.baseUrl, token: 'wrong_token_here' },
    ]);
    serverA = await startFedServer({
      instanceId: 'a',
      peersJson: peersForA,
    });

    // A publishes — B will reject with 401 (fire-and-forget, non-fatal).
    serverA.sync.publishEvent('rejected-test', { data: 1 });

    // Give the async fetch a moment to complete and be logged (not strictly required
    // for seq, which increments synchronously before fan-out).
    await new Promise(r => setTimeout(r, 100));

    // A's seq must have incremented (seq is incremented before fan-out).
    expect(serverA.sync.getOutboundSeq()).toBe(1);

    // B must not have received the event.
    expect(serverB.sync.getInboundEventCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // FED-INT-06: missing peer name in registry → fetchPeerTail returns []
  // -------------------------------------------------------------------------
  it('FED-INT-06: fetchPeerTail for unknown peer name returns []', async () => {
    serverA = await startFedServer({
      instanceId: 'a',
      // No peers configured.
    });

    const result = await serverA.sync.fetchPeerTail('nonexistent-peer', 0);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // FED-INT-07: peer unreachable → publishEvent is non-fatal, seq increments
  // -------------------------------------------------------------------------
  it('FED-INT-07: unreachable peer URL → publish non-fatal, seq increments', async () => {
    // Port 1 is privileged/reserved — connection will be refused immediately.
    const peersForA = JSON.stringify([
      { name: 'dead-peer', url: 'http://127.0.0.1:1', token: TOKEN_A_TO_B },
    ]);
    serverA = await startFedServer({
      instanceId: 'a',
      peersJson: peersForA,
    });

    // publishEvent must not throw — it's fire-and-forget.
    expect(() => {
      serverA!.sync.publishEvent('timeout-test', { will: 'fail' });
    }).not.toThrow();

    // Seq increments synchronously before the failed fetch attempt.
    expect(serverA.sync.getOutboundSeq()).toBe(1);
  }, 10_000); // Allow up to 10 s for connection refused to settle

  // -------------------------------------------------------------------------
  // FED-INT-08: tail pagination — since=0 returns all, since=future returns none
  // -------------------------------------------------------------------------
  it('FED-INT-08: tail pagination with since parameter', async () => {
    serverB = await startFedServer({
      instanceId: 'b',
      inboundTokensJson: JSON.stringify([TOKEN_A_TO_B]),
    });

    // Directly ingest 3 events with correct bearer.
    for (let i = 1; i <= 3; i++) {
      await post(
        `${serverB.baseUrl}/v1/federation/audit/ingest`,
        {
          id: `pag-evt-${i}`,
          instanceId: 'a',
          eventType: 'pag-test',
          payload: { n: i },
          ts: Date.now(),
          seq: i,
        },
        TOKEN_A_TO_B,
      );
    }

    // since=0 → all 3 events.
    const allResp = await get(
      `${serverB.baseUrl}/v1/federation/audit/tail?since=0&limit=100`,
      TOKEN_A_TO_B,
    );
    expect(allResp.status).toBe(200);
    const allData = allResp.json as { ok: boolean; data: { events: unknown[]; count: number } };
    expect(allData.ok).toBe(true);
    expect(allData.data.count).toBe(3);

    // since=far future → 0 events.
    const futureTs = Date.now() + 999_999_999;
    const futureResp = await get(
      `${serverB.baseUrl}/v1/federation/audit/tail?since=${futureTs}&limit=100`,
      TOKEN_A_TO_B,
    );
    expect(futureResp.status).toBe(200);
    const futureData = futureResp.json as { ok: boolean; data: { events: unknown[]; count: number } };
    expect(futureData.data.count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // FED-INT-09: B fetches A's audit tail via fetchPeerTail (bidirectional read)
  // -------------------------------------------------------------------------
  it('FED-INT-09: B can fetchPeerTail from A (bidirectional)', async () => {
    // Start A first so we have its port.
    serverA = await startFedServer({
      instanceId: 'a',
      inboundTokensJson: JSON.stringify([TOKEN_B_TO_A]),
    });

    // Start B knowing A's URL — B uses TOKEN_B_TO_A when reading A's tail.
    const peersForB = JSON.stringify([
      { name: 'a', url: serverA.baseUrl, token: TOKEN_B_TO_A },
    ]);
    serverB = await startFedServer({
      instanceId: 'b',
      peersJson: peersForB,
      inboundTokensJson: JSON.stringify([TOKEN_A_TO_B]),
    });

    // Manually ingest an event on A's inbound table (simulating A received from someone).
    await post(
      `${serverA.baseUrl}/v1/federation/audit/ingest`,
      {
        id: 'bidi-evt-001',
        instanceId: 'x',
        eventType: 'bidi-test',
        payload: { direction: 'B-reads-A' },
        ts: Date.now(),
        seq: 1,
      },
      TOKEN_B_TO_A,
    );

    // B fetches A's inbound tail (what A received from others).
    const events = await serverB.sync.fetchPeerTail('a', 0, 50);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.instanceId).toBe('x');
    expect(events[0]!.eventType).toBe('bidi-test');
  });

  // -------------------------------------------------------------------------
  // FED-INT-10: malformed event body → 400
  // -------------------------------------------------------------------------
  it('FED-INT-10: malformed event body (missing required fields) → 400', async () => {
    serverB = await startFedServer({
      instanceId: 'b',
      inboundTokensJson: JSON.stringify([TOKEN_A_TO_B]),
    });

    // Missing 'ts' and 'seq' — should be 400.
    const { status } = await post(
      `${serverB.baseUrl}/v1/federation/audit/ingest`,
      { instanceId: 'a', eventType: 'bad-event', payload: {} },
      TOKEN_A_TO_B,
    );
    expect(status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // FED-INT-11: multiple events from A accumulate on B
  // -------------------------------------------------------------------------
  it('FED-INT-11: multiple events from A accumulate on B', async () => {
    serverB = await startFedServer({
      instanceId: 'b',
      inboundTokensJson: JSON.stringify([TOKEN_A_TO_B]),
    });

    const peersForA = JSON.stringify([
      { name: 'b', url: serverB.baseUrl, token: TOKEN_A_TO_B },
    ]);
    serverA = await startFedServer({
      instanceId: 'a',
      peersJson: peersForA,
    });

    // Publish 5 events from A — each gets an incremented seq.
    for (let i = 0; i < 5; i++) {
      serverA.sync.publishEvent(`multi-event-${i}`, { index: i });
    }

    // Wait until B has all 5 events.
    const allArrived = await waitFor(() => serverB!.sync.getInboundEventCount() >= 5, 3000);
    expect(allArrived).toBe(true);

    const events = serverB.sync.queryInboundTail(0, 20);
    expect(events.length).toBe(5);

    // All events must come from A.
    for (const ev of events) {
      expect(ev.instanceId).toBe('a');
    }

    // Seqs must form a contiguous sequence 1–5 (after sorting).
    const seqs = events.map(e => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  // -------------------------------------------------------------------------
  // FED-INT-12: B's stats endpoint reflects inbound count after handshake
  // -------------------------------------------------------------------------
  it('FED-INT-12: B stats endpoint reflects inbound count', async () => {
    serverB = await startFedServer({
      instanceId: 'b',
      inboundTokensJson: JSON.stringify([TOKEN_A_TO_B]),
    });

    const peersForA = JSON.stringify([
      { name: 'b', url: serverB.baseUrl, token: TOKEN_A_TO_B },
    ]);
    serverA = await startFedServer({
      instanceId: 'a',
      peersJson: peersForA,
    });

    // Baseline: B has 0 inbound events.
    const before = await get(`${serverB.baseUrl}/v1/federation/stats`, ADMIN_TOKEN);
    expect(before.status).toBe(200);
    const beforeData = before.json as { ok: boolean; data: { inboundEventCount: number } };
    expect(beforeData.data.inboundEventCount).toBe(0);

    // A publishes one event to B.
    serverA.sync.publishEvent('stats-test', { probe: true });

    // Wait for B to receive it.
    const arrived = await waitFor(() => serverB!.sync.getInboundEventCount() > 0);
    expect(arrived).toBe(true);

    // Stats must now reflect count = 1.
    const after = await get(`${serverB.baseUrl}/v1/federation/stats`, ADMIN_TOKEN);
    expect(after.status).toBe(200);
    const afterData = after.json as {
      ok: boolean;
      data: {
        inboundEventCount: number;
        peersConfigured: number;
        outboundSeq: number;
        lastInboundTs: number | null;
      };
    };
    expect(afterData.data.inboundEventCount).toBe(1);
    expect(afterData.data.lastInboundTs).not.toBeNull();
  });
});
