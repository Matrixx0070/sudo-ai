import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from './bus.js';
import { EventStore } from './store.js';

function nextTick(): Promise<void> {
  return new Promise((r) => setImmediate(() => setImmediate(r)));
}

describe('EventBus', () => {
  let dir: string;
  let store: EventStore;
  let bus: EventBus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'events-bus-'));
    store = new EventStore(join(dir, 'e.db'));
    bus = new EventBus();
    bus.setStore(store);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('publish persists persistent events and fans out to subscribers + queue', async () => {
    store.createEndpoint({ name: 'n', url: 'https://x.example', eventTypes: ['message.*'] });
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));

    const evt = bus.publish('message.completed', { session_id: 's1' }, { channels: ['session:s1'] });
    expect(evt.id).toMatch(/^evt_/);
    expect(store.getEvent(evt.id)).not.toBeNull();
    expect(store.listDeliveries()).toHaveLength(1);
    await nextTick();
    expect(seen).toEqual(['message.completed']);
  });

  it('ephemeral events reach subscribers but are never persisted/queued', async () => {
    store.createEndpoint({ name: 'n', url: 'https://x.example', eventTypes: ['*'] });
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.type));
    const evt = bus.publish('session.output.delta', { chunk: 'hi' }, { channels: ['session:s1'] });
    expect(store.getEvent(evt.id)).toBeNull();
    expect(store.listDeliveries()).toHaveLength(0);
    await nextTick();
    expect(seen).toEqual(['session.output.delta']);
  });

  it('a throwing subscriber never breaks others or the publisher', async () => {
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe((e) => seen.push(e.type));
    expect(() => bus.publish('notification', { m: 1 })).not.toThrow();
    await nextTick();
    expect(seen).toEqual(['notification']);
  });

  it('idempotencyKey defaults to the event id and is honoured when supplied', () => {
    const a = bus.publish('notification', {});
    expect(a.idempotencyKey).toBe(a.id);
    const b = bus.publish('notification', {}, { idempotencyKey: 'k1' });
    expect(b.idempotencyKey).toBe('k1');
  });

  it('unsubscribe stops delivery', async () => {
    const seen: string[] = [];
    const un = bus.subscribe((e) => seen.push(e.type));
    un();
    bus.publish('notification', {});
    await nextTick();
    expect(seen).toEqual([]);
  });
});
