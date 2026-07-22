/**
 * @file tests/journeys/journey-2-failover-outbox.test.ts
 * @description GW-13 Journey 2 — model failover → durable delivery.
 *
 * Exercises the GW-2 cost-cliff fix end-to-end at the subsystem level. Crucially,
 * the failover chain here is built from the REAL production config order
 * (config/sudo-ai.json5 `models.primary`, the same array brain.ts feeds to
 * `new ModelFailover(...)`), NOT a re-encoded literal — so this journey actually
 * regresses if someone reorders the config to put the expensive no-cache grok-4.5
 * tier ahead of the cheap cache-friendly grok-4-fast tier (the cost cliff). The
 * config's first primary tier is scripted to fail transiently; failover must hop
 * over REAL HTTP to the next tier, obtain the reply, and the reply must land in
 * the GW-15 durable outbox and ack exactly once.
 *
 * Assertions are on observable artifacts: the production config order, the
 * stub's request log (which routes were tried, in order), and the outbox row.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import { ModelFailover } from '../../src/core/brain/failover.js';
import { DeliveryQueue } from '../../src/core/channels/delivery-queue.js';
import { startLlmStub, callStub, type LlmStub } from './llm-stub-server.js';
import { makeJourneyEnv, type JourneyEnv } from './harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Read the real production primary-model order — the array brain.ts feeds ModelFailover. */
function productionPrimaryModelIds(): string[] {
  const cfgPath = path.resolve(__dirname, '../../config/sudo-ai.json5');
  const cfg = JSON5.parse(readFileSync(cfgPath, 'utf8')) as {
    models?: { primary?: Array<{ id: string }> };
  };
  return (cfg.models?.primary ?? []).map((m) => m.id);
}

describe('GW-13 Journey 2 — failover → durable delivery', () => {
  let env: JourneyEnv;
  let stub: LlmStub | undefined;
  let queues: DeliveryQueue[] = [];
  afterEach(async () => {
    for (const q of queues) q.close();
    queues = [];
    await stub?.close();
    stub = undefined;
    env?.cleanup();
  });

  it('production config is cheap-first; a real failover hop persists + acks once', async () => {
    env = makeJourneyEnv('failover');

    // The chain order is READ FROM PRODUCTION CONFIG, not re-encoded here.
    const primary = productionPrimaryModelIds();
    expect(primary.length).toBeGreaterThanOrEqual(2);

    // Cost-cliff guard on the REAL order: the cheap cache-friendly grok-4-fast
    // tier must precede the expensive no-cache grok-4.5 escalation. This is the
    // regression the fix targets — if config reorders 4.5 ahead of fast, it trips.
    // 2026-07-22 (Frank, NO-GO): grok is deliberately OFF models.primary right
    // now (see memory project-grok-provider) — guard stays for if/when it's
    // re-added; nothing to order while both tiers are absent.
    const fastIdx = primary.findIndex((m) => /grok-4-fast/i.test(m));
    const cliffIdx = primary.findIndex((m) => /grok-4\.5/.test(m));
    if (fastIdx !== -1 && cliffIdx !== -1) expect(fastIdx).toBeLessThan(cliffIdx); // fast BEFORE 4.5

    // Drive a real failover hop over HTTP using PRODUCTION order: the config's
    // first primary tier is transiently down, the next tier answers. (Using the
    // real ordered list, not a re-encoded literal.)
    const first = primary[0];
    const second = primary[1];
    stub = await startLlmStub({
      [first]: { status: 500 },
      [second]: { status: 200, reply: 'failover reply' },
    });

    // Build the chain exactly as production does: ModelFailover(primary ids).
    const failover = new ModelFailover(primary);

    // Drive the real chain over real HTTP until a route answers.
    let reply: string | null = null;
    for (let hop = 0; hop < primary.length + 1 && reply === null; hop++) {
      const profile = failover.getNextProfile();
      expect(profile).not.toBeNull();
      const res = await callStub(stub.baseUrl, profile!.id, 'hello');
      if (res.status >= 500) {
        failover.recordError(profile!.id, failover.categorizeError(res.status));
        continue;
      }
      failover.recordSuccess(profile!.id);
      reply = res.reply;
    }

    expect(reply).toBe('failover reply');

    // The stub proves the REAL config's first tier was tried first, then a genuine
    // hop to the second — driven by production order, not a test literal.
    const order = stub.modelsTried();
    expect(order[0]).toBe(first);
    expect(order).toContain(second);
    expect(order.indexOf(first)).toBeLessThan(order.indexOf(second));

    // The recovered reply lands in the durable outbox and is delivered once.
    const outbox = new DeliveryQueue(env.outboxDbPath, { mediaDir: `${env.dataDir}/m` });
    queues.push(outbox);
    outbox.enqueue({ channel: 'telegram', account: 'default', peer: 'owner', text: reply! });
    const sent: string[] = [];
    const state = await outbox.dispatchOne(async (d) => { sent.push(d.text); });
    expect(state).toBe('acked');
    expect(sent).toEqual(['failover reply']);
    expect(outbox.countByState('acked')).toBe(1);
  });
});
