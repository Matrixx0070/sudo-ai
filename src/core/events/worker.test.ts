import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyEventSignature } from './signing.js';
import { EventStore } from './store.js';
import { newEventId, type PlatformEvent } from './types.js';
import { DeliveryWorker, webhookBody, type FetchLike } from './worker.js';

function evt(): PlatformEvent {
  const id = newEventId();
  return { id, type: 'message.completed', version: 1, createdAt: new Date().toISOString(), idempotencyKey: id, channels: [], data: { hello: 'world' } };
}

describe('DeliveryWorker', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'events-worker-')); store = new EventStore(join(dir, 'e.db')); });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('delivers a signed POST the receiver can verify', async () => {
    const ep = store.createEndpoint({ name: 'n', url: 'https://receiver.example/h', eventTypes: ['*'] });
    const e = evt();
    store.insertEvent(e);
    store.enqueueDirect(ep, e);

    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url, init };
      return new Response('ok', { status: 200 });
    };
    const worker = new DeliveryWorker({ store, fetchImpl });
    expect(await worker.tick()).toBe(1);

    expect(captured).not.toBeNull();
    const { url, init } = captured!;
    expect(url).toBe(ep.url);
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Sudo-Event']).toBe('message.completed');
    expect(headers['X-Sudo-Event-Id']).toBe(e.id);
    expect(headers['X-Sudo-Idempotency-Key']).toBe(e.idempotencyKey);
    const body = String(init.body);
    expect(body).toBe(webhookBody(e));
    expect(JSON.parse(body)).toMatchObject({ id: e.id, type: e.type, version: 1, data: { hello: 'world' } });
    // Receiver-side verification with the endpoint's secret.
    expect(verifyEventSignature(ep.secret, headers['X-Sudo-Signature']!, headers['X-Sudo-Timestamp']!, body).ok).toBe(true);

    const d = store.listDeliveries({ endpointId: ep.id })[0]!;
    expect(d.status).toBe('succeeded');
    expect(d.lastStatusCode).toBe(200);
    expect(store.listAttempts(d.id)).toHaveLength(1);
  });

  it('non-2xx and thrown errors schedule retries, then DLQ', async () => {
    const ep = store.createEndpoint({ name: 'n', url: 'https://receiver.example/h', eventTypes: ['*'], retryMax: 1 });
    const e = evt();
    store.insertEvent(e);
    const d0 = store.enqueueDirect(ep, e)!;

    let calls = 0;
    const fetchImpl: FetchLike = async () => { calls += 1; return new Response('nope', { status: 503 }); };
    const worker = new DeliveryWorker({ store, fetchImpl });

    await worker.tick();
    let d = store.getDelivery(d0.id)!;
    expect(d.status).toBe('pending');
    expect(d.lastStatusCode).toBe(503);

    // Second (final) attempt at its scheduled time → dead.
    await worker.tick(d.nextAttemptAt + 1);
    d = store.getDelivery(d0.id)!;
    expect(d.status).toBe('dead');
    expect(calls).toBe(2);
  });

  it('network exception counts as a failed attempt', async () => {
    const ep = store.createEndpoint({ name: 'n', url: 'https://receiver.example/h', eventTypes: ['*'], retryMax: 0 });
    const e = evt();
    store.insertEvent(e);
    const d0 = store.enqueueDirect(ep, e)!;
    const worker = new DeliveryWorker({ store, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    await worker.tick();
    const d = store.getDelivery(d0.id)!;
    expect(d.status).toBe('dead'); // retryMax 0 → single attempt
    expect(d.lastError).toContain('ECONNREFUSED');
  });

  it('disabled endpoint defers without consuming attempts', async () => {
    const ep = store.createEndpoint({ name: 'n', url: 'https://receiver.example/h', eventTypes: ['*'] });
    const e = evt();
    store.insertEvent(e);
    const d0 = store.enqueueDirect(ep, e)!;
    store.updateEndpoint(ep.id, { enabled: false });
    let calls = 0;
    const worker = new DeliveryWorker({ store, fetchImpl: async () => { calls += 1; return new Response('', { status: 200 }); } });
    await worker.tick();
    const d = store.getDelivery(d0.id)!;
    expect(calls).toBe(0);
    expect(d.status).toBe('pending');
    expect(d.attempt).toBe(0);
  });

  it('an orphaned delivery (event pruned) is dead-ended, never wedges the queue', async () => {
    const ep = store.createEndpoint({ name: 'n', url: 'https://receiver.example/h', eventTypes: ['*'] });
    const e = evt();
    store.insertEvent(e);
    store.enqueueDirect(ep, e);
    // Orphan the delivery: retention prune drops the EVENT while the pending
    // delivery survives (prune only removes settled deliveries).
    const worker = new DeliveryWorker({ store, fetchImpl: async () => new Response('', { status: 200 }) });
    store.prune(Date.now() + 40 * 24 * 3_600_000);
    expect(store.getEvent(e.id)).toBeNull();
    await worker.tick(Date.now() + 40 * 24 * 3_600_000);
    // Either pruned with the settled set or dead-ended — the queue must not wedge.
    const left = store.listDeliveries({ status: 'pending' });
    expect(left).toHaveLength(0);
  });
});
