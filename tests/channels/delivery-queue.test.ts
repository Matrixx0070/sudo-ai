/**
 * @file tests/channels/delivery-queue.test.ts
 * @description GW-15 durable outbound delivery queue — crash-mid-send safety,
 * presend retry + backoff + attempt cap, error classification, media spool
 * cleanup, and boot recovery. Uses an in-memory better-sqlite3 DB and an
 * injected clock so backoff/TTL are deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DeliveryQueue,
  defaultClassifier,
  type DeliverFn,
  type DeliveryAlert,
} from '../../src/core/channels/delivery-queue.js';
import { telegramClassifier } from '../../src/core/channels/durable-outbox.js';

function mkQueue(opts: Partial<{ now: () => number; onAlert: (a: DeliveryAlert) => void; mediaDir: string; classify: (e: unknown) => 'presend' | 'postsend' | 'unknown' }> = {}, db?: Database.Database) {
  const database = db ?? new Database(':memory:');
  return { db: database, q: new DeliveryQueue(database, { backoffBaseMs: 1000, ...opts }) };
}

describe('GW-15 DeliveryQueue', () => {
  let mediaDir: string;
  beforeEach(() => { mediaDir = mkdtempSync(path.join(tmpdir(), 'outbox-media-')); });
  afterEach(() => { rmSync(mediaDir, { recursive: true, force: true }); });

  it('happy path: enqueue → dispatch → acked, deliver called once', async () => {
    const { q } = mkQueue();
    const id = q.enqueue({ channel: 'telegram', account: 'default', peer: 'p1', text: 'hi' });
    let calls = 0;
    const deliver: DeliverFn = async () => { calls += 1; };
    const state = await q.dispatchOne(deliver);
    expect(state).toBe('acked');
    expect(calls).toBe(1);
    expect(q.get(id)?.state).toBe('acked');
  });

  it('crash mid-send: a dispatched row at boot becomes unknown and is NOT re-sent', async () => {
    const db = new Database(':memory:');
    let now = 1_000_000;
    const { q } = mkQueue({ now: () => now }, db);
    const id = q.enqueue({ channel: 'telegram', account: 'default', peer: 'p1', text: 'hi' });

    // Claim + mark dispatched, then "crash" before ack (deliver hangs / dies).
    const row = q.claimNext();
    expect(row?.id).toBe(id);
    let delivered = 0;
    // Simulate the crash: dispatchRow marks dispatched BEFORE the send; kill by
    // throwing an unclassifiable-as-crash — instead we manually stop after
    // dispatched by never acking. Emulate via a deliver that records + never returns.
    // Simpler: use a fresh queue over the SAME db that recovers a 'dispatched' row.
    db.prepare(`UPDATE deliveries SET state='dispatched', attempt=1 WHERE id=@id`).run({ id });

    const recovered = mkQueue({ now: () => now }, db);
    const rec = recovered.q.recover();
    expect(rec.orphanedDispatched).toBe(1);
    expect(recovered.q.get(id)?.state).toBe('unknown');

    // A drain after recovery must NOT pick up the unknown row.
    const state = await recovered.q.dispatchOne(async () => { delivered += 1; });
    expect(state).toBeNull();
    expect(delivered).toBe(0);
  });

  it('presend failure retries with exponential backoff then caps at 5 attempts', async () => {
    let now = 0;
    const { q } = mkQueue({ now: () => now });
    q.enqueue({ channel: 'telegram', account: 'default', peer: 'p1', text: 'hi' });
    const presendErr = Object.assign(new Error('net down'), { code: 'ECONNREFUSED' });
    const deliver: DeliverFn = async () => { throw presendErr; };

    // Attempt 1 → pending, next at now+1000
    expect(await q.dispatchOne(deliver)).toBe('pending');
    // Not yet eligible (backoff not elapsed)
    expect(await q.dispatchOne(deliver)).toBeNull();

    // Walk the backoff: 1s, 2s, 4s, 8s → attempts 2..5
    for (const step of [1000, 2000, 4000, 8000]) {
      now += step;
      const s = await q.dispatchOne(deliver);
      // last one exhausts the cap
      expect(['pending', 'failed-presend']).toContain(s);
    }
    // After 5 attempts it is terminally failed-presend
    expect(q.countByState('failed-presend')).toBe(1);
  });

  it('postsend classification (definitive 4xx) is terminal, not retried', async () => {
    const { q } = mkQueue();
    const id = q.enqueue({ channel: 'telegram', account: 'default', peer: 'p1', text: '' });
    const rejectErr = Object.assign(new Error('Bad Request: message text is empty'), { status: 400 });
    const state = await q.dispatchOne(async () => { throw rejectErr; });
    expect(state).toBe('failed-postsend');
    expect(q.get(id)?.state).toBe('failed-postsend');
  });

  it('ambiguous error (5xx) → unknown, surfaced via alert, not retried', async () => {
    const alerts: DeliveryAlert[] = [];
    const { q } = mkQueue({ onAlert: (a) => alerts.push(a) });
    q.enqueue({ channel: 'telegram', account: 'default', peer: 'p1', text: 'hi' });
    const state = await q.dispatchOne(async () => { throw Object.assign(new Error('gateway timeout'), { status: 504 }); });
    expect(state).toBe('unknown');
    expect(alerts.some((a) => a.kind === 'unknown-surfaced')).toBe(true);
  });

  it('media is spooled on enqueue and cleaned up on ack', async () => {
    const { q } = mkQueue({ mediaDir });
    const id = q.enqueue({
      channel: 'telegram', account: 'default', peer: 'p1', text: 'see attached',
      media: [{ filename: 'a.png', data: Buffer.from('PNGDATA') }],
    });
    expect(q.hasSpool(id)).toBe(true);
    const captured: string[] = [];
    await q.dispatchOne(async (d) => { captured.push(...d.mediaPaths); });
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain(id);
    expect(q.hasSpool(id)).toBe(false); // cleaned up on ack
  });

  it('recover reclaims stale claimed rows and drops aged-out unknown rows', async () => {
    let now = 100_000_000; // > unknownTtlMs so the aged unknown row's cutoff is positive
    const db = new Database(':memory:');
    const { q } = mkQueue({ now: () => now, claimTtlMs: 60_000, unknownTtlMs: 24 * 60 * 60_000 }, db);
    const staleId = q.enqueue({ channel: 'telegram', account: 'default', peer: 'p1', text: 'a' });
    q.claimNext(); // claims staleId, claimed_at = now
    // age past the claim TTL
    now += 61_000;
    // seed an aged unknown row directly
    db.prepare(`INSERT INTO deliveries (id, channel, account, peer, payload_ref, state, attempt, created_at, next_attempt_at, updated_at)
      VALUES ('u1','telegram','default','p2','{"text":"x","media":[]}','unknown',3,0,0,0)`).run();

    const rec = q.recover();
    expect(rec.reclaimedClaimed).toBe(1);
    expect(q.get(staleId)?.state).toBe('pending');
    expect(rec.droppedUnknown).toBe(1);
    expect(q.get('u1')).toBeUndefined();
  });

  it('a duplicate enqueue is a separate delivery (queue does not dedupe — that is GW-8 upstream)', () => {
    const { q } = mkQueue();
    q.enqueue({ channel: 'telegram', account: 'default', peer: 'p1', text: 'hi' });
    q.enqueue({ channel: 'telegram', account: 'default', peer: 'p1', text: 'hi' });
    expect(q.countByState('pending')).toBe(2);
  });
});

describe('GW-15 error classifiers', () => {
  it('defaultClassifier: tagged wins, connection codes → presend, 4xx → postsend, else unknown', () => {
    expect(defaultClassifier(Object.assign(new Error(), { deliveryClass: 'unknown' }))).toBe('unknown');
    expect(defaultClassifier(Object.assign(new Error(), { code: 'ETIMEDOUT' }))).toBe('presend');
    expect(defaultClassifier(Object.assign(new Error(), { code: 'channel_not_connected' }))).toBe('presend');
    expect(defaultClassifier(Object.assign(new Error(), { status: 403 }))).toBe('postsend');
    expect(defaultClassifier(Object.assign(new Error(), { status: 500 }))).toBe('unknown');
    expect(defaultClassifier(new Error('who knows'))).toBe('unknown');
  });

  it('telegramClassifier: HttpError → presend, 429 → presend, other 4xx → postsend, 5xx → unknown', () => {
    expect(telegramClassifier({ name: 'HttpError' })).toBe('presend');
    expect(telegramClassifier({ name: 'GrammyError', error_code: 429 })).toBe('presend');
    expect(telegramClassifier({ name: 'GrammyError', error_code: 400 })).toBe('postsend');
    expect(telegramClassifier({ name: 'GrammyError', error_code: 500 })).toBe('unknown');
  });
});
