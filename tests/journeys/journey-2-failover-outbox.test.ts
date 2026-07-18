/**
 * @file tests/journeys/journey-2-failover-outbox.test.ts
 * @description GW-13 Journey 2 — model failover → durable delivery.
 *
 * Exercises the GW-2 cost-cliff fix end-to-end at the subsystem level: a real
 * {@link ModelFailover} chain drives real HTTP calls to the scriptable LLM stub.
 * The cheap cache-friendly tier is tried FIRST (the fix — grok-4-fast before the
 * expensive no-cache grok-4.5 escalation); here it is transiently failing, so
 * failover hops to the expensive route, obtains the reply, and the reply lands
 * in the GW-15 durable outbox and is acked exactly once.
 *
 * Assertions are on observable artifacts: the stub's request log (which routes
 * were tried, in order) and the outbox row state — never on internals.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ModelFailover } from '../../src/core/brain/failover.js';
import { DeliveryQueue } from '../../src/core/channels/delivery-queue.js';
import { startLlmStub, callStub, type LlmStub } from './llm-stub-server.js';
import { makeJourneyEnv, type JourneyEnv } from './harness.js';

describe('GW-13 Journey 2 — failover → durable delivery', () => {
  let env: JourneyEnv;
  let stub: LlmStub | undefined;
  afterEach(async () => {
    await stub?.close();
    stub = undefined;
    env?.cleanup();
  });

  it('cheap tier tried first; on its failure escalate, then persist + ack once', async () => {
    env = makeJourneyEnv('failover');
    // The cost-cliff fix orders the cheap cache-friendly tier BEFORE the
    // expensive no-cache escalation. Here the cheap tier is transiently down.
    const CHEAP = 'xai/grok-4-fast-reasoning'; // priority 0 — tried first
    const EXPENSIVE = 'xai/grok-4.5'; // the no-cache escalation
    stub = await startLlmStub({
      [CHEAP]: { status: 500 },
      [EXPENSIVE]: { status: 200, reply: 'failover reply' },
    });

    // Chain order encodes the fix: cheap tier first, expensive escalation behind it.
    const failover = new ModelFailover([CHEAP, EXPENSIVE]);

    // Drive the real chain over real HTTP until a route answers.
    let reply: string | null = null;
    for (let hop = 0; hop < 5 && reply === null; hop++) {
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

    // The stub proves cheap-first order and that a real hop occurred.
    const order = stub.modelsTried();
    expect(order).toContain(CHEAP);
    expect(order).toContain(EXPENSIVE);
    expect(order.indexOf(CHEAP)).toBeLessThan(order.indexOf(EXPENSIVE));

    // The recovered reply lands in the durable outbox and is delivered once.
    const outbox = new DeliveryQueue(env.outboxDbPath, { mediaDir: `${env.dataDir}/m` });
    outbox.enqueue({ channel: 'telegram', account: 'default', peer: 'owner', text: reply! });
    const sent: string[] = [];
    const state = await outbox.dispatchOne(async (d) => { sent.push(d.text); });
    expect(state).toBe('acked');
    expect(sent).toEqual(['failover reply']);
    expect(outbox.countByState('acked')).toBe(1);
  });
});
