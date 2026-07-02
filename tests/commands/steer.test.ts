/**
 * @file tests/commands/steer.test.ts
 * @description /steer directive — signals the steering channel for the running
 * turn's session (abort / inject / reprioritize). Complements /stop (which only
 * discards the reply); /steer abort actually stops the loop.
 */

import { describe, it, expect } from 'vitest';
import { steerCommand } from '../../src/core/commands/builtin/steer.js';
import { CommandRegistry } from '../../src/core/commands/registry.js';
import { registerBuiltinCommands } from '../../src/core/commands/index.js';
import type { CommandContext } from '../../src/core/commands/types.js';

type Sig = { action: string; payload?: string };
function fakeChannel() {
  const signals: Array<{ sessionId: string; sig: Sig }> = [];
  return {
    signals,
    signal(sessionId: string, sig: Sig) { signals.push({ sessionId, sig }); },
  };
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    channel: 'telegram',
    peerId: 'peer-1',
    sessionId: 'sess-42',
    agentLoop: null,
    toolRegistry: null,
    config: null,
    db: null,
    ...overrides,
  };
}

describe('/steer', () => {
  it('abort → signals abort for the session and confirms', async () => {
    const ch = fakeChannel();
    const reply = await steerCommand.execute('abort', makeCtx({ steeringChannel: ch }));
    expect(ch.signals).toEqual([{ sessionId: 'sess-42', sig: { action: 'abort', payload: undefined } }]);
    expect(reply.toLowerCase()).toContain('abort signalled');
  });

  it('abort <reason> → carries the reason as payload', async () => {
    const ch = fakeChannel();
    await steerCommand.execute('abort changed my mind', makeCtx({ steeringChannel: ch }));
    expect(ch.signals[0]!.sig).toEqual({ action: 'abort', payload: 'changed my mind' });
  });

  it('inject <text> → signals inject with the text', async () => {
    const ch = fakeChannel();
    await steerCommand.execute('inject focus on the failing test', makeCtx({ steeringChannel: ch }));
    expect(ch.signals[0]!.sig).toEqual({ action: 'inject', payload: 'focus on the failing test' });
  });

  it('reprioritize <text> → signals reprioritize with the text', async () => {
    const ch = fakeChannel();
    await steerCommand.execute('reprioritize switch to the urgent bug', makeCtx({ steeringChannel: ch }));
    expect(ch.signals[0]!.sig).toEqual({ action: 'reprioritize', payload: 'switch to the urgent bug' });
  });

  it('inject with no text → error, no signal', async () => {
    const ch = fakeChannel();
    const reply = await steerCommand.execute('inject', makeCtx({ steeringChannel: ch }));
    expect(ch.signals).toHaveLength(0);
    expect(reply).toContain('needs text');
  });

  it('unknown action → usage help, no signal', async () => {
    const ch = fakeChannel();
    const reply = await steerCommand.execute('bogus stuff', makeCtx({ steeringChannel: ch }));
    expect(ch.signals).toHaveLength(0);
    expect(reply).toContain('Usage:');
  });

  it('no steering channel wired → graceful message, no throw', async () => {
    const reply = await steerCommand.execute('abort', makeCtx()); // no steeringChannel
    expect(reply).toContain('not available');
  });

  it('is registered as a builtin command', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    expect(registry.get('steer')).toBeDefined();
  });
});
