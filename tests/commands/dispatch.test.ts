/**
 * @file tests/commands/dispatch.test.ts
 * @description Channel-agnostic directive dispatch (gap #11) — slash commands
 * short-circuit the agent turn on every channel. Mirrors the Telegram
 * adapter's intercept semantics: non-commands and missing contexts fall
 * through (false); commands are consumed (true) even when the reply fails.
 */

import { describe, it, expect, vi } from 'vitest';
import { CommandRegistry } from '../../src/core/commands/registry.js';
import { tryDispatchDirective } from '../../src/core/commands/dispatch.js';
import type { CommandContext } from '../../src/core/commands/types.js';

function makeCtx(): CommandContext {
  return {
    channel: 'discord',
    peerId: 'peer-1',
    sessionId: 'sess-1',
    agentLoop: null,
    toolRegistry: null,
    config: null,
    db: null,
  };
}

function makeRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register({
    name: 'ping',
    description: 'test command',
    usage: '/ping',
    execute: async (args: string) => `pong${args ? ` ${args}` : ''}`,
  });
  return registry;
}

describe('tryDispatchDirective', () => {
  it('ignores non-command text without building a context', async () => {
    const makeContext = vi.fn(async () => makeCtx());
    const reply = vi.fn(async () => undefined);
    const handled = await tryDispatchDirective({
      registry: makeRegistry(),
      msg: { channel: 'discord', peerId: 'peer-1', text: 'hello there' },
      makeContext,
      reply,
    });
    expect(handled).toBe(false);
    expect(makeContext).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('executes a known command, replies with its output, and consumes the message', async () => {
    const reply = vi.fn(async () => undefined);
    const handled = await tryDispatchDirective({
      registry: makeRegistry(),
      msg: { channel: 'slack', peerId: 'peer-1', text: '/ping now' },
      makeContext: async () => makeCtx(),
      reply,
    });
    expect(handled).toBe(true);
    expect(reply).toHaveBeenCalledWith('pong now');
  });

  it('replies with the unknown-command message instead of falling through to the agent', async () => {
    const reply = vi.fn(async () => undefined);
    const handled = await tryDispatchDirective({
      registry: makeRegistry(),
      msg: { channel: 'sms', peerId: 'peer-1', text: '/nosuchcmd' },
      makeContext: async () => makeCtx(),
      reply,
    });
    expect(handled).toBe(true);
    expect(String(reply.mock.calls[0]?.[0])).toContain('Unknown command');
  });

  it('falls through (false) when the context factory returns null', async () => {
    const reply = vi.fn(async () => undefined);
    const handled = await tryDispatchDirective({
      registry: makeRegistry(),
      msg: { channel: 'email', peerId: 'peer-1', text: '/ping' },
      makeContext: async () => null,
      reply,
    });
    expect(handled).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });

  it('falls through (false) when the context factory throws', async () => {
    const handled = await tryDispatchDirective({
      registry: makeRegistry(),
      msg: { channel: 'web', peerId: 'peer-1', text: '/ping' },
      makeContext: async () => { throw new Error('db locked'); },
      reply: vi.fn(async () => undefined),
    });
    expect(handled).toBe(false);
  });

  it('still consumes the message when the reply send fails', async () => {
    const handled = await tryDispatchDirective({
      registry: makeRegistry(),
      msg: { channel: 'whatsapp', peerId: 'peer-1', text: '/ping' },
      makeContext: async () => makeCtx(),
      reply: vi.fn(async () => { throw new Error('send failed'); }),
    });
    expect(handled).toBe(true);
  });

  it('handles undefined text safely', async () => {
    const handled = await tryDispatchDirective({
      registry: makeRegistry(),
      msg: { channel: 'irc', peerId: 'peer-1' },
      makeContext: async () => makeCtx(),
      reply: vi.fn(async () => undefined),
    });
    expect(handled).toBe(false);
  });
});
