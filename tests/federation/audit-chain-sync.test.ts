/**
 * @file tests/federation/audit-chain-sync.test.ts
 * @description AuditChainSync unit tests — Wave 7E.
 *
 * Uses in-memory better-sqlite3 DB. Mocks global fetch for outbound tests.
 *
 * Tests:
 *   SYNC-1   ensureSchema creates tables on construction
 *   SYNC-2   ingestEvent stores a valid event and returns 'ok'
 *   SYNC-3   ingestEvent returns 'duplicate' on same instanceId+seq
 *   SYNC-4   getInboundEventCount returns correct count
 *   SYNC-5   getLastInboundTs returns null when no events
 *   SYNC-6   getLastInboundTs returns a timestamp after ingestion
 *   SYNC-7   getOutboundSeq returns 0 before any publish
 *   SYNC-8   publishEvent increments seq and fires fetch to each peer
 *   SYNC-9   publishEvent skips fetch when no peers configured
 *   SYNC-10  publishEvent: fetch failure is non-fatal (no throw)
 *   SYNC-11  queryInboundTail returns events since given timestamp
 *   SYNC-12  queryInboundTail excludes events before since
 *   SYNC-13  fetchPeerTail returns [] for unknown peer
 *   SYNC-14  fetchPeerTail calls fetch and returns events on success
 *   SYNC-15  fetchPeerTail returns [] on fetch error
 *   SYNC-16  publishEvent ignores invalid eventType
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AuditChainSync } from '../../src/core/federation/audit-chain-sync.js';
import { PeerRegistry } from '../../src/core/federation/peer-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInMemoryDb(): ReturnType<typeof Database> {
  return new Database(':memory:');
}

function makeEmptyRegistry(): PeerRegistry {
  return new PeerRegistry(undefined, undefined);
}

function makePeerRegistry(peers: Array<{ name: string; url: string; token: string }>): PeerRegistry {
  return new PeerRegistry(JSON.stringify(peers), undefined);
}

const INSTANCE_ID = 'test-instance-42';

// ---------------------------------------------------------------------------
// SYNC-1: Schema creation
// ---------------------------------------------------------------------------
describe('AuditChainSync — schema', () => {
  it('SYNC-1: creates tables on construction', () => {
    const db = makeInMemoryDb();
    new AuditChainSync(db, makeEmptyRegistry(), INSTANCE_ID);

    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    expect(names).toContain('federation_outbound_seq');
    expect(names).toContain('federation_inbound_audit');
  });
});

// ---------------------------------------------------------------------------
// SYNC-2 to 6: ingestEvent + queries
// ---------------------------------------------------------------------------
describe('AuditChainSync — ingestEvent', () => {
  it('SYNC-2: ingestEvent stores a valid event and returns ok', () => {
    const db = makeInMemoryDb();
    const sync = new AuditChainSync(db, makeEmptyRegistry(), INSTANCE_ID);

    const result = sync.ingestEvent({
      id: 'evt-001',
      instanceId: 'remote-instance',
      eventType: 're-anchor',
      payload: { trigger: 'post-veto' },
      ts: 1_700_000_000_000,
      seq: 1,
    });
    expect(result).toBe('ok');
  });

  it('SYNC-3: ingestEvent returns duplicate on same instanceId+seq', () => {
    const db = makeInMemoryDb();
    const sync = new AuditChainSync(db, makeEmptyRegistry(), INSTANCE_ID);

    const event = {
      id: 'evt-001',
      instanceId: 'remote-instance',
      eventType: 're-anchor',
      payload: {},
      ts: 1_700_000_000_000,
      seq: 1,
    };

    expect(sync.ingestEvent(event)).toBe('ok');
    // Second call with same instanceId+seq (different id)
    expect(sync.ingestEvent({ ...event, id: 'evt-001-dup' })).toBe('duplicate');
  });

  it('SYNC-4: getInboundEventCount returns correct count', () => {
    const db = makeInMemoryDb();
    const sync = new AuditChainSync(db, makeEmptyRegistry(), INSTANCE_ID);
    expect(sync.getInboundEventCount()).toBe(0);

    sync.ingestEvent({ id: 'e1', instanceId: 'remote', eventType: 'test', payload: {}, ts: 1000, seq: 1 });
    sync.ingestEvent({ id: 'e2', instanceId: 'remote', eventType: 'test', payload: {}, ts: 1001, seq: 2 });
    expect(sync.getInboundEventCount()).toBe(2);
  });

  it('SYNC-5: getLastInboundTs returns null when no events', () => {
    const db = makeInMemoryDb();
    const sync = new AuditChainSync(db, makeEmptyRegistry(), INSTANCE_ID);
    expect(sync.getLastInboundTs()).toBeNull();
  });

  it('SYNC-6: getLastInboundTs returns a timestamp after ingestion', () => {
    const db = makeInMemoryDb();
    const sync = new AuditChainSync(db, makeEmptyRegistry(), INSTANCE_ID);
    const before = Date.now();
    sync.ingestEvent({ id: 'e1', instanceId: 'remote', eventType: 'test', payload: {}, ts: 1000, seq: 1 });
    const after = Date.now();
    const ts = sync.getLastInboundTs();
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(after + 50);
  });
});

// ---------------------------------------------------------------------------
// SYNC-7: outboundSeq before publish
// ---------------------------------------------------------------------------
describe('AuditChainSync — outbound seq', () => {
  it('SYNC-7: getOutboundSeq returns 0 before any publish', () => {
    const db = makeInMemoryDb();
    const sync = new AuditChainSync(db, makeEmptyRegistry(), INSTANCE_ID);
    expect(sync.getOutboundSeq()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SYNC-8 to 10: publishEvent (mocked fetch)
// ---------------------------------------------------------------------------
describe('AuditChainSync — publishEvent', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('SYNC-8: publishEvent increments seq and calls fetch for each peer', async () => {
    const db = makeInMemoryDb();
    const registry = makePeerRegistry([
      { name: 'peer-a', url: 'https://peer-a.example.com:18900', token: 'sk_a' },
      { name: 'peer-b', url: 'https://peer-b.example.com:18900', token: 'sk_b' },
    ]);
    const sync = new AuditChainSync(db, registry, INSTANCE_ID);

    sync.publishEvent('re-anchor', { trigger: 'post-veto' });

    // Allow microtask queue to flush
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(sync.getOutboundSeq()).toBe(1);
  });

  it('SYNC-9: publishEvent skips fetch when no peers configured', async () => {
    const db = makeInMemoryDb();
    const sync = new AuditChainSync(db, makeEmptyRegistry(), INSTANCE_ID);

    sync.publishEvent('re-anchor', { trigger: 'test' });
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('SYNC-10: publishEvent does not throw when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const db = makeInMemoryDb();
    const registry = makePeerRegistry([
      { name: 'peer-a', url: 'https://peer-a.example.com:18900', token: 'sk_a' },
    ]);
    const sync = new AuditChainSync(db, registry, INSTANCE_ID);

    // Should not throw
    expect(() => sync.publishEvent('re-anchor', {})).not.toThrow();
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  });

  it('SYNC-16: publishEvent ignores empty eventType', async () => {
    const db = makeInMemoryDb();
    const registry = makePeerRegistry([
      { name: 'peer-a', url: 'https://peer-a.example.com:18900', token: 'sk_a' },
    ]);
    const sync = new AuditChainSync(db, registry, INSTANCE_ID);

    sync.publishEvent('', { trigger: 'test' });
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SYNC-11 + 12: queryInboundTail
// ---------------------------------------------------------------------------
describe('AuditChainSync — queryInboundTail', () => {
  it('SYNC-11: returns events since given timestamp', () => {
    const db = makeInMemoryDb();
    const sync = new AuditChainSync(db, makeEmptyRegistry(), INSTANCE_ID);

    const sinceMs = 1_700_000_000_000;
    sync.ingestEvent({ id: 'e1', instanceId: 'remote', eventType: 'test', payload: { a: 1 }, ts: sinceMs + 100, seq: 1 });
    sync.ingestEvent({ id: 'e2', instanceId: 'remote', eventType: 'test', payload: { a: 2 }, ts: sinceMs + 200, seq: 2 });

    const events = sync.queryInboundTail(0, 100);
    expect(events).toHaveLength(2);
    expect(events[0]!.seq).toBe(1);
    expect(events[1]!.seq).toBe(2);
  });

  it('SYNC-12: excludes events received before since timestamp', () => {
    const db = makeInMemoryDb();
    const sync = new AuditChainSync(db, makeEmptyRegistry(), INSTANCE_ID);

    // Ingest first
    sync.ingestEvent({ id: 'e1', instanceId: 'remote', eventType: 'test', payload: {}, ts: 1000, seq: 1 });
    const after = Date.now() + 1000; // far future
    // Should return empty since we ask for events received after 'after'
    const events = sync.queryInboundTail(after, 100);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SYNC-13 to 15: fetchPeerTail (mocked fetch)
// ---------------------------------------------------------------------------
describe('AuditChainSync — fetchPeerTail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('SYNC-13: returns [] for unknown peer', async () => {
    const db = makeInMemoryDb();
    const sync = new AuditChainSync(db, makeEmptyRegistry(), INSTANCE_ID);
    const result = await sync.fetchPeerTail('nonexistent', 0);
    expect(result).toEqual([]);
  });

  it('SYNC-14: calls fetch and returns events on success', async () => {
    const mockEvents = [
      { id: 'evt-remote-1', instanceId: 'remote', eventType: 're-anchor', payload: {}, ts: 1000, seq: 1, receivedAt: 1001 },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { events: mockEvents } }),
    }));

    const db = makeInMemoryDb();
    const registry = makePeerRegistry([
      { name: 'peer-a', url: 'https://peer-a.example.com:18900', token: 'sk_a' },
    ]);
    const sync = new AuditChainSync(db, registry, INSTANCE_ID);

    const events = await sync.fetchPeerTail('peer-a', 0);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('evt-remote-1');
  });

  it('SYNC-15: returns [] on fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    const db = makeInMemoryDb();
    const registry = makePeerRegistry([
      { name: 'peer-a', url: 'https://peer-a.example.com:18900', token: 'sk_a' },
    ]);
    const sync = new AuditChainSync(db, registry, INSTANCE_ID);

    const events = await sync.fetchPeerTail('peer-a', 0);
    expect(events).toEqual([]);
  });
});
