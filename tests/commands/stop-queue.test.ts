/**
 * @file tests/commands/stop-queue.test.ts
 * @description /stop and /queue directives (gap #11). /stop bumps the
 * conversation's run generation so the in-flight reply is discarded at the
 * stale check; /queue inspects the per-peer KeyedAsyncQueue.
 */

import { describe, it, expect } from 'vitest';
import { stopCommand } from '../../src/core/commands/builtin/stop.js';
import { queueCommand } from '../../src/core/commands/builtin/queue.js';
import { CommandRegistry } from '../../src/core/commands/registry.js';
import { registerBuiltinCommands } from '../../src/core/commands/index.js';
import { runGenerations } from '../../src/core/sessions/run-generation.js';
import { KeyedAsyncQueue } from '../../src/core/sessions/queue.js';
import type { CommandContext } from '../../src/core/commands/types.js';

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    channel: 'discord',
    peerId: `peer-${Math.random().toString(36).slice(2)}`,
    sessionId: 'sess-1',
    agentLoop: null,
    toolRegistry: null,
    config: null,
    db: null,
    ...overrides,
  };
}

describe('/stop', () => {
  it('bumps the run generation so an in-flight turn is detected as stale', async () => {
    const ctx = makeCtx();
    const key = `${ctx.channel}:${ctx.peerId}`;
    const inFlightGen = runGenerations.current(key);

    const reply = await stopCommand.execute('', ctx);

    expect(runGenerations.isStale(key, inFlightGen)).toBe(true);
    expect(reply).toContain('Stop signal sent');
    expect(reply).toContain('/reset');
  });

  it('is honest that the model call is not aborted mid-flight', async () => {
    const reply = await stopCommand.execute('', makeCtx());
    expect(reply).toContain('not aborted');
  });
});

describe('/queue', () => {
  it('reports busy when this peer has an active task chain', async () => {
    const queue = new KeyedAsyncQueue();
    const ctx = makeCtx({ peerQueue: queue });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const task = queue.enqueue(ctx.peerId, () => gate);

    const reply = await queueCommand.execute('', ctx);
    expect(reply).toContain('busy');
    expect(reply).toContain('Peers with active work : 1');

    release();
    await task;
  });

  it('reports idle when the queue has no work for this peer', async () => {
    const ctx = makeCtx({ peerQueue: new KeyedAsyncQueue() });
    const reply = await queueCommand.execute('', ctx);
    expect(reply).toContain('idle');
  });

  it('recognises the router queue key form channel:peerId', async () => {
    const queue = new KeyedAsyncQueue();
    const ctx = makeCtx({ peerQueue: queue, channel: 'irc' });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const task = queue.enqueue(`${ctx.channel}:${ctx.peerId}`, () => gate);

    const reply = await queueCommand.execute('', ctx);
    expect(reply).toContain('busy');

    release();
    await task;
  });

  it('degrades gracefully when no queue is in the context', async () => {
    const reply = await queueCommand.execute('', makeCtx());
    expect(reply).toContain('not available');
  });
});

describe('core command registration', () => {
  it('registers /stop and /queue alongside the existing core set', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    expect(registry.get('stop')).toBeDefined();
    expect(registry.get('queue')).toBeDefined();
    expect(registry.get('reset')).toBeDefined();
    expect(registry.get('model')).toBeDefined();
  });
});
