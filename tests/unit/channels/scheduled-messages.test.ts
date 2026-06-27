/**
 * Unit tests for ScheduledMessageStore, ScheduledMessageDispatcher, and the
 * singleton helpers. Real better-sqlite3 :memory: DB with initializeSchema.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { initializeSchema } from '../../../src/core/memory/schema.js';
import {
  ScheduledMessageStore,
  ScheduledMessageDispatcher,
  setScheduledMessageInstance,
  getScheduledMessageInstance,
  MIN_RECURRENCE_SEC,
  MAX_RETRIES,
  type ChannelSender,
  type ContentGenerator,
} from '../../../src/core/channels/scheduled-messages.js';

function createDb(): DatabaseType {
  const db = new Database(':memory:');
  initializeSchema(db);
  return db;
}

const pastTime = (): string => new Date(Date.now() - 1000).toISOString();
const futureTime = (): string => new Date(Date.now() + 60_000).toISOString();

function baseMsg(overrides: Partial<Parameters<ScheduledMessageStore['insert']>[0]> = {}) {
  return {
    channel: 'telegram' as const,
    peerId: '12345',
    content: 'hello from the daemon',
    scheduleTime: pastTime(),
    ...overrides,
  };
}

describe('ScheduledMessageStore', () => {
  let db: DatabaseType;
  let store: ScheduledMessageStore;

  beforeEach(() => {
    db = createDb();
    store = new ScheduledMessageStore(db);
  });

  it('insert returns a pending message and list/get find it', () => {
    const m = store.insert(baseMsg());
    expect(m.status).toBe('pending');
    expect(m.retryCount).toBe(0);
    expect(m.id).toBeTruthy();
    expect(store.list()).toHaveLength(1);
    expect(store.get(m.id)?.content).toBe('hello from the daemon');
  });

  it('getDue returns past-due but not future messages', () => {
    const due = store.insert(baseMsg({ scheduleTime: pastTime() }));
    store.insert(baseMsg({ scheduleTime: futureTime() }));
    const list = store.getDue(new Date().toISOString());
    expect(list.map((m) => m.id)).toEqual([due.id]);
  });

  it('markSent removes a message from the due set', () => {
    const m = store.insert(baseMsg());
    store.markSent(m.id);
    expect(store.get(m.id)?.status).toBe('sent');
    expect(store.getDue(new Date().toISOString())).toHaveLength(0);
  });

  it('cancel sets status cancelled and reports whether a row changed', () => {
    const m = store.insert(baseMsg());
    expect(store.cancel(m.id)).toBe(true);
    expect(store.get(m.id)?.status).toBe('cancelled');
    expect(store.getDue(new Date().toISOString())).toHaveLength(0);
    expect(store.cancel('does-not-exist')).toBe(false);
  });

  it('markFailed increments retry_count and excludes after MAX_RETRIES', () => {
    const m = store.insert(baseMsg());
    for (let i = 0; i < MAX_RETRIES; i++) {
      expect(store.getDue(new Date().toISOString()).map((x) => x.id)).toContain(m.id);
      store.markFailed(m.id, 'boom');
    }
    // After MAX_RETRIES failures the message is permanently excluded.
    expect(store.get(m.id)?.retryCount).toBe(MAX_RETRIES);
    expect(store.getDue(new Date().toISOString())).toHaveLength(0);
  });

  it('reschedule pushes schedule_time forward and re-arms (pending, retries reset)', () => {
    const m = store.insert(baseMsg({ recurrenceSec: MIN_RECURRENCE_SEC }));
    store.markFailed(m.id, 'transient');
    const next = new Date(Date.now() + MIN_RECURRENCE_SEC * 1000).toISOString();
    store.reschedule(m.id, next);
    const after = store.get(m.id)!;
    expect(after.status).toBe('pending');
    expect(after.retryCount).toBe(0);
    expect(Date.parse(after.scheduleTime)).toBeGreaterThan(Date.now());
  });

  it('round-trips recurrenceSec (null for one-shot)', () => {
    const oneShot = store.insert(baseMsg());
    const recurring = store.insert(baseMsg({ recurrenceSec: 300 }));
    expect(store.get(oneShot.id)?.recurrenceSec).toBeUndefined();
    expect(store.get(recurring.id)?.recurrenceSec).toBe(300);
  });
});

describe('ScheduledMessageDispatcher.tick', () => {
  let db: DatabaseType;
  let sender: ReturnType<typeof vi.fn>;
  let dispatcher: ScheduledMessageDispatcher;

  beforeEach(() => {
    db = createDb();
    sender = vi.fn().mockResolvedValue(undefined);
    dispatcher = new ScheduledMessageDispatcher(db, sender as unknown as ChannelSender);
  });

  it('delivers a due one-shot message and marks it sent', async () => {
    const m = dispatcher.store.insert(baseMsg({ channel: 'telegram', peerId: '999', content: 'ping' }));
    await dispatcher.tick();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith('telegram', '999', 'ping');
    expect(dispatcher.store.get(m.id)?.status).toBe('sent');
  });

  it('does not deliver future messages', async () => {
    dispatcher.store.insert(baseMsg({ scheduleTime: futureTime() }));
    await dispatcher.tick();
    expect(sender).not.toHaveBeenCalled();
  });

  it('reschedules a recurring message forward instead of marking it sent', async () => {
    const m = dispatcher.store.insert(baseMsg({ recurrenceSec: MIN_RECURRENCE_SEC, scheduleTime: pastTime() }));
    await dispatcher.tick();
    expect(sender).toHaveBeenCalledTimes(1);
    const after = dispatcher.store.get(m.id)!;
    expect(after.status).toBe('pending');
    expect(Date.parse(after.scheduleTime)).toBeGreaterThan(Date.now());
    // Not due again immediately.
    await dispatcher.tick();
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('marks a message failed when the sender throws, and stops after MAX_RETRIES', async () => {
    sender.mockRejectedValue(new Error('channel down'));
    const m = dispatcher.store.insert(baseMsg());
    for (let i = 0; i < MAX_RETRIES; i++) await dispatcher.tick();
    expect(sender).toHaveBeenCalledTimes(MAX_RETRIES);
    expect(dispatcher.store.get(m.id)?.status).toBe('failed');
    expect(dispatcher.store.get(m.id)?.retryCount).toBe(MAX_RETRIES);
    // Exhausted — no further delivery attempts.
    await dispatcher.tick();
    expect(sender).toHaveBeenCalledTimes(MAX_RETRIES);
  });

  it('one bad message does not abort delivery of the others in the same tick', async () => {
    sender
      .mockRejectedValueOnce(new Error('first fails'))
      .mockResolvedValue(undefined);
    dispatcher.store.insert(baseMsg({ peerId: 'A' }));
    dispatcher.store.insert(baseMsg({ peerId: 'B' }));
    await dispatcher.tick();
    expect(sender).toHaveBeenCalledTimes(2);
  });
});

describe('ScheduledMessageDispatcher — dynamic prompt (generate-at-send)', () => {
  let db: DatabaseType;
  let sender: ReturnType<typeof vi.fn>;
  let generator: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createDb();
    sender = vi.fn().mockResolvedValue(undefined);
    generator = vi.fn().mockResolvedValue('generated digest body');
  });

  function makeDispatcher(withGenerator = true): ScheduledMessageDispatcher {
    return new ScheduledMessageDispatcher(
      db,
      sender as unknown as ChannelSender,
      withGenerator ? (generator as unknown as ContentGenerator) : undefined,
    );
  }

  it('generates the body from the prompt at send time and delivers it', async () => {
    const d = makeDispatcher();
    const m = d.store.insert(baseMsg({ content: '', prompt: 'summarize today', peerId: 'P' }));
    await d.tick();
    expect(generator).toHaveBeenCalledWith('summarize today');
    expect(sender).toHaveBeenCalledWith('telegram', 'P', 'generated digest body');
    expect(d.store.get(m.id)?.status).toBe('sent');
  });

  it('fixed-content messages ignore the generator', async () => {
    const d = makeDispatcher();
    d.store.insert(baseMsg({ content: 'fixed text', peerId: 'Q' }));
    await d.tick();
    expect(generator).not.toHaveBeenCalled();
    expect(sender).toHaveBeenCalledWith('telegram', 'Q', 'fixed text');
  });

  it('fails (and retries) when the generator returns empty', async () => {
    generator.mockResolvedValue('   ');
    const d = makeDispatcher();
    const m = d.store.insert(baseMsg({ content: '', prompt: 'x' }));
    await d.tick();
    expect(sender).not.toHaveBeenCalled();
    expect(d.store.get(m.id)?.status).toBe('failed');
  });

  it('fails when a prompt message has no generator configured', async () => {
    const d = makeDispatcher(false);
    const m = d.store.insert(baseMsg({ content: '', prompt: 'x' }));
    await d.tick();
    expect(sender).not.toHaveBeenCalled();
    expect(d.store.get(m.id)?.status).toBe('failed');
    expect(d.store.get(m.id)?.errorMessage).toMatch(/generator/i);
  });

  it('regenerates fresh content on each recurring delivery', async () => {
    generator.mockResolvedValueOnce('digest #1').mockResolvedValueOnce('digest #2');
    const d = makeDispatcher();
    d.store.insert(baseMsg({ content: '', prompt: 'daily', recurrenceSec: MIN_RECURRENCE_SEC, scheduleTime: pastTime() }));
    await d.tick();
    expect(sender).toHaveBeenNthCalledWith(1, 'telegram', '12345', 'digest #1');
    const id = d.store.list()[0]!.id;
    d.store.reschedule(id, pastTime()); // force due again
    await d.tick();
    expect(sender).toHaveBeenNthCalledWith(2, 'telegram', '12345', 'digest #2');
  });
});

describe('scheduled-message singleton', () => {
  it('set/get returns the live dispatcher', () => {
    const db = createDb();
    const d = new ScheduledMessageDispatcher(db, (async () => {}) as ChannelSender);
    setScheduledMessageInstance(d);
    expect(getScheduledMessageInstance()).toBe(d);
  });
});
