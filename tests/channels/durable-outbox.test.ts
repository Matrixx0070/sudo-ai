/**
 * @file tests/channels/durable-outbox.test.ts
 * @description GW-15 integration seam — installDurableOutbox registers an
 * enqueue wrapper, the drain loop delivers via the raw sender, and media-bearing
 * sends bypass the queue to the raw sender (text-only durable path this slice).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { DeliveryQueue } from '../../src/core/channels/delivery-queue.js';
import { installDurableOutbox } from '../../src/core/channels/durable-outbox.js';
import type { OutboundSender } from '../../src/core/channels/channel-outbox.js';

describe('GW-15 installDurableOutbox', () => {
  it('enqueues text sends and drains them through the raw sender', async () => {
    const q = new DeliveryQueue(new Database(':memory:'));
    const rawCalls: Array<{ peer: string; text: string }> = [];
    let wrapper: OutboundSender | undefined;

    const handle = installDurableOutbox({
      queue: q,
      channel: 'telegram',
      rawSend: async (peer, text) => { rawCalls.push({ peer, text }); },
      registerWrapper: (send) => { wrapper = send; },
      pollMs: 10,
    });

    expect(wrapper).toBeDefined();
    await wrapper!('p1', 'hello');
    // Not delivered yet — it is queued.
    expect(rawCalls.length).toBe(0);
    expect(q.countByState('pending')).toBe(1);

    const drained = await handle.drainOnce();
    expect(drained).toBe(1);
    expect(rawCalls).toEqual([{ peer: 'p1', text: 'hello' }]);
    handle.stop();
  });

  it('media-bearing sends bypass the queue and go straight to the raw sender', async () => {
    const q = new DeliveryQueue(new Database(':memory:'));
    const rawCalls: Array<{ peer: string; hasMedia: boolean }> = [];
    let wrapper: OutboundSender | undefined;

    const handle = installDurableOutbox({
      queue: q,
      channel: 'telegram',
      rawSend: async (peer, _text, opts) => { rawCalls.push({ peer, hasMedia: !!opts?.media?.length }); },
      registerWrapper: (send) => { wrapper = send; },
      pollMs: 10,
    });

    await wrapper!('p1', 'caption', { media: [{ kind: 'image', data: Buffer.from('x'), mimeType: 'image/png' } as never] });
    expect(rawCalls).toEqual([{ peer: 'p1', hasMedia: true }]);
    expect(q.countByState('pending')).toBe(0); // bypassed the queue
    handle.stop();
  });
});
