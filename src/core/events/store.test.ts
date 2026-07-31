import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKOFF_MS, EventStore } from './store.js';
import type { PlatformEvent } from './types.js';
import { newEventId } from './types.js';

function evt(type = 'message.completed', idem?: string): PlatformEvent {
  const id = newEventId();
  return { id, type, version: 1, createdAt: new Date().toISOString(), idempotencyKey: idem ?? id, channels: ['session:s1'], data: { n: 1 } };
}

describe('EventStore', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'events-store-'));
    store = new EventStore(join(dir, 'events.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('endpoint CRUD + secret masking fields', () => {
    const ep = store.createEndpoint({ name: 'n', url: 'https://x.example/h', eventTypes: ['*'] });
    expect(ep.secret).toMatch(/^whsec_/);
    expect(ep.retryMax).toBe(5);
    expect(store.listEndpoints()).toHaveLength(1);
    const upd = store.updateEndpoint(ep.id, { enabled: false, eventTypes: ['message.completed'], retryMax: 2 })!;
    expect(upd.enabled).toBe(0);
    expect(upd.eventTypes).toEqual(['message.completed']);
    expect(upd.retryMax).toBe(2);
    expect(store.deleteEndpoint(ep.id)).toBe(true);
    expect(store.getEndpoint(ep.id)).toBeNull();
  });

  it('event log insert/list/filter', () => {
    const e1 = evt('message.completed');
    const e2 = evt('tool.started');
    store.insertEvent(e1); store.insertEvent(e2);
    expect(store.getEvent(e1.id)?.data).toEqual({ n: 1 });
    expect(store.listEvents({ type: 'tool.started' }).map((e) => e.id)).toEqual([e2.id]);
    expect(store.listEvents()).toHaveLength(2);
  });

  it('fan-out honours subscriptions, enabled flag, and wildcard patterns', () => {
    store.createEndpoint({ name: 'all', url: 'https://a.example', eventTypes: ['*'] });
    store.createEndpoint({ name: 'tools', url: 'https://b.example', eventTypes: ['tool.*'] });
    store.createEndpoint({ name: 'off', url: 'https://c.example', eventTypes: ['*'], enabled: false });
    const e = evt('message.completed');
    store.insertEvent(e);
    expect(store.enqueueForEvent(e)).toBe(1); // only 'all'
    const t = evt('tool.failed');
    store.insertEvent(t);
    expect(store.enqueueForEvent(t)).toBe(2); // 'all' + 'tools'
  });

  it('idempotency: same key enqueues once per endpoint', () => {
    const ep = store.createEndpoint({ name: 'n', url: 'https://x.example', eventTypes: ['*'] });
    const a = evt('message.completed', 'stable-key');
    const b = evt('message.completed', 'stable-key');
    store.insertEvent(a); store.insertEvent(b);
    expect(store.enqueueDirect(ep, a)).not.toBeNull();
    expect(store.enqueueDirect(ep, b)).toBeNull();
    expect(store.listDeliveries({ endpointId: ep.id })).toHaveLength(1);
  });

  it('retry backoff schedule → DLQ, then replay re-arms', () => {
    const ep = store.createEndpoint({ name: 'n', url: 'https://x.example', eventTypes: ['*'], retryMax: 2 });
    const e = evt();
    store.insertEvent(e);
    const now = 1_000_000;
    const d0 = store.enqueueDirect(ep, e, now)!;
    expect(d0.maxAttempts).toBe(3);
    let claimed = store.claimDue(now, 10);
    expect(claimed).toHaveLength(1);
    let d = store.recordAttempt(claimed[0]!, { ok: false, statusCode: 500, error: 'HTTP 500', durationMs: 5 }, now);
    expect(d.status).toBe('pending');
    expect(d.nextAttemptAt).toBe(now + BACKOFF_MS[0]!);

    // Not due yet.
    expect(store.claimDue(now + 1, 10)).toHaveLength(0);

    claimed = store.claimDue(d.nextAttemptAt, 10);
    d = store.recordAttempt(claimed[0]!, { ok: false, error: 'timeout', durationMs: 5 }, d.nextAttemptAt);
    expect(d.status).toBe('pending');
    expect(d.nextAttemptAt - claimed[0]!.nextAttemptAt).toBe(BACKOFF_MS[1]!);

    claimed = store.claimDue(d.nextAttemptAt, 10);
    d = store.recordAttempt(claimed[0]!, { ok: false, error: 'timeout', durationMs: 5 }, d.nextAttemptAt);
    expect(d.status).toBe('dead'); // attempt budget spent → DLQ
    expect(store.listAttempts(d.id)).toHaveLength(3);

    const replayed = store.replay(d.id, d.nextAttemptAt + 1)!;
    expect(replayed.status).toBe('pending');
    expect(replayed.maxAttempts).toBe(replayed.attempt + 3); // fresh budget

    const again = store.claimDue(d.nextAttemptAt + 2, 10);
    const done = store.recordAttempt(again[0]!, { ok: true, statusCode: 200, durationMs: 4 });
    expect(done.status).toBe('succeeded');
  });

  it('rotateSecret keeps the previous secret co-signing within grace', () => {
    const ep = store.createEndpoint({ name: 'n', url: 'https://x.example', eventTypes: ['*'] });
    const now = Date.now();
    const rotated = store.rotateSecret(ep.id, now)!;
    expect(rotated.secret).not.toBe(ep.secret);
    expect(store.signingSecrets(rotated, now)).toEqual([rotated.secret, ep.secret]);
    expect(store.signingSecrets(rotated, now + 25 * 3_600_000)).toEqual([rotated.secret]);
  });

  it('defer pushes a delivery out without consuming an attempt', () => {
    const ep = store.createEndpoint({ name: 'n', url: 'https://x.example', eventTypes: ['*'] });
    const e = evt(); store.insertEvent(e);
    const d = store.enqueueDirect(ep, e)!;
    store.claimDue(Date.now(), 10);
    store.defer(d.id, Date.now() + 60_000);
    const after = store.getDelivery(d.id)!;
    expect(after.status).toBe('pending');
    expect(after.attempt).toBe(0);
  });
});
