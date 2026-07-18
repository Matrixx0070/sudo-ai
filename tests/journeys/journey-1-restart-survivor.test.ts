/**
 * @file tests/journeys/journey-1-restart-survivor.test.ts
 * @description GW-13 Journey 1 (MVP) — restart-survivor.
 *
 * Ties GW-9 (verified restart handoff) and GW-15 (durable outbound queue)
 * across a simulated process boundary, asserting only on OBSERVABLE ARTIFACTS
 * (on-disk SQLite rows + sentinel files) — the journey-shaped bug class behind
 * #751 (empty-reply → Telegram silence) and the "lost chats" fork loop.
 *
 * Scenario:
 *   1. Predecessor enqueues two outbound replies (#A in-flight, #B still queued)
 *      into the durable outbox at data/outbox.db, then records a restart intent.
 *   2. The predecessor CRASHES mid-send: reply #A is committed as `dispatched`
 *      (the pre-send pivot) but never acked — the platform MAY already have it.
 *   3. The successor boots over the SAME data dir: outbox boot-recovery moves the
 *      orphaned #A to `unknown` (never re-sent → the human is never
 *      double-messaged), and the sentinel handoff completes (ready.json written,
 *      intent cleared, boot reports it resumed an intended restart).
 *   4. The successor drains the queue: reply #B is delivered exactly once.
 *
 * Everything is real code over a real on-disk DB; a "restart" is a fresh set of
 * objects over the same directory. The Docker wrapper is only the CI vehicle.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DeliveryQueue } from '../../src/core/channels/delivery-queue.js';
import {
  writeRestartIntent,
  completeBootHandoff,
  readReady,
  readRestartIntent,
} from '../../src/core/health/restart-sentinel.js';
import { makeJourneyEnv, handoffCompleted, type JourneyEnv } from './harness.js';

describe('GW-13 Journey 1 — restart-survivor', () => {
  let env: JourneyEnv;
  afterEach(() => env?.cleanup());

  it('durable outbox + sentinel survive a mid-send crash without double-messaging', async () => {
    env = makeJourneyEnv('restart');
    const mediaDir = `${env.dataDir}/outbox-media`;

    // ---- Predecessor: enqueue two replies -------------------------------
    const pre = new DeliveryQueue(env.outboxDbPath, { mediaDir });
    const idA = pre.enqueue({ channel: 'telegram', account: 'default', peer: 'owner', text: 'reply-A (in flight)' });
    const idB = pre.enqueue({ channel: 'telegram', account: 'default', peer: 'owner', text: 'reply-B (queued)' });
    expect(pre.countByState('pending')).toBe(2);

    // Predecessor records intent BEFORE the restart (GW-9).
    writeRestartIntent(env.restartDir, { reason: 'journey-restart', initiator: 'updater', gitSha: 'deadbee' });
    expect(readRestartIntent(env.restartDir)?.initiator).toBe('updater');

    // ---- Crash mid-send: #A is committed `dispatched`, never acked -------
    // This is exactly the on-disk state a process is in when it dies between the
    // pre-send pivot and the ack (the module's sanctioned crash model).
    const claimed = pre.claimNext();
    expect(claimed?.id).toBe(idA);
    const raw = new Database(env.outboxDbPath);
    raw.prepare(`UPDATE deliveries SET state='dispatched', attempt=1 WHERE id=@id`).run({ id: idA });
    raw.close();
    // (predecessor process is now gone)

    // ---- Successor boots over the SAME data dir -------------------------
    const post = new DeliveryQueue(env.outboxDbPath, { mediaDir });
    const rec = post.recover();
    expect(rec.orphanedDispatched).toBe(1); // #A rescued from limbo
    expect(post.get(idA)?.state).toBe('unknown'); // NEVER auto-resent

    // Sentinel handoff completes once init is done.
    const handoff = completeBootHandoff(env.restartDir, { port: 18900, gitSha: 'cafef00' });
    expect(handoff.resumed).toBe(true);
    expect(handoff.staleHandoff).toBe(false);
    expect(handoff.intent?.reason).toBe('journey-restart');
    expect(handoffCompleted(env.restartDir)).toBe(true);
    expect(readReady(env.restartDir)?.port).toBe(18900);
    expect(readRestartIntent(env.restartDir)).toBeNull();

    // ---- Drain: #B delivered exactly once, #A never touched ------------
    const sent: string[] = [];
    let state: string | null;
    do {
      state = await post.dispatchOne(async (d) => { sent.push(d.text); });
    } while (state !== null);

    expect(sent).toEqual(['reply-B (queued)']); // #B once; #A (unknown) skipped
    expect(post.countByState('acked')).toBe(1);
    expect(post.countByState('unknown')).toBe(1);
    // The human received #B once and was never double-messaged with #A.
    expect(sent.filter((t) => t.includes('reply-A')).length).toBe(0);
    void idB;
  });

  it('a stale intent at successor boot is flagged as a failed prior handoff', () => {
    env = makeJourneyEnv('restart-stale');
    // Intent written 20 minutes ago (> DEFAULT_STALE_MS 10m) and never completed.
    const now = 5_000_000;
    writeRestartIntent(env.restartDir, { reason: 'crash-loop', initiator: 'kairos', now: now - 20 * 60_000 });
    const handoff = completeBootHandoff(env.restartDir, { port: 18900, now });
    expect(handoff.resumed).toBe(true);
    expect(handoff.staleHandoff).toBe(true); // → posture/telemetry flag, Kairos cooldown
  });
});
