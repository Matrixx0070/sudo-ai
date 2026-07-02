/**
 * @file tests/commands/directive-auth.test.ts
 * @description Shared directive-auth layer: makeDirectiveAuthorizer (owner gate
 * for state/turn-control directives) + tryDispatchDirective honoring the
 * `authorize` hook (deny → not executed, not an agent turn).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeDirectiveAuthorizer } from '../../src/core/commands/directive-authorizer.js';
import { tryDispatchDirective, type DirectiveMessage } from '../../src/core/commands/dispatch.js';
import { CommandRegistry } from '../../src/core/commands/registry.js';

const msg = (over: Partial<DirectiveMessage> = {}): DirectiveMessage => ({
  channel: 'discord', peerId: 'peer-1', text: '/steer abort', ...over,
});

describe('makeDirectiveAuthorizer', () => {
  const savedOwners = process.env['SUDO_DIRECTIVE_OWNERS'];
  beforeEach(() => { delete process.env['SUDO_DIRECTIVE_OWNERS']; });
  afterEach(() => {
    if (savedOwners === undefined) delete process.env['SUDO_DIRECTIVE_OWNERS'];
    else process.env['SUDO_DIRECTIVE_OWNERS'] = savedOwners;
  });

  it('always allows read-only directives regardless of owner', () => {
    const authz = makeDirectiveAuthorizer({});
    expect(authz(msg({ channel: 'discord', peerId: 'anyone' }), 'help')).toBe(true);
    expect(authz(msg({ channel: 'discord', peerId: 'anyone' }), 'status')).toBe(true);
  });

  it('SUDO_DIRECTIVE_OWNERS gates a sensitive directive uniformly (bare id + channel:id)', () => {
    process.env['SUDO_DIRECTIVE_OWNERS'] = 'owner-1, discord:owner-2';
    const authz = makeDirectiveAuthorizer({});
    expect(authz(msg({ peerId: 'owner-1' }), 'steer')).toBe(true);          // bare id
    expect(authz(msg({ channel: 'discord', peerId: 'owner-2' }), 'stop')).toBe(true); // channel:id
    expect(authz(msg({ peerId: 'intruder' }), 'steer')).toBe(false);        // not an owner
  });

  it('falls back to a channel allowlist when no explicit owners set', () => {
    const authz = makeDirectiveAuthorizer({ channels: { telegram: { allowedUsers: ['tg-owner'] } } });
    expect(authz(msg({ channel: 'telegram', peerId: 'tg-owner' }), 'reset')).toBe(true);
    expect(authz(msg({ channel: 'telegram', peerId: 'stranger' }), 'reset')).toBe(false);
  });

  it('allows (prior behaviour) when a channel has no owner model configured', () => {
    const authz = makeDirectiveAuthorizer({}); // no owners, discord has no allowlist
    expect(authz(msg({ channel: 'discord', peerId: 'whoever' }), 'steer')).toBe(true);
  });
});

describe('tryDispatchDirective authorize hook', () => {
  function registryWithSpy() {
    const registry = new CommandRegistry();
    registry.register({
      name: 'steer', description: 'x', usage: '/steer',
      execute: vi.fn(async () => 'executed'),
    });
    return registry;
  }

  it('DENY → command not executed and consumed (not an agent turn)', async () => {
    const registry = registryWithSpy();
    const exec = registry.get('steer')!.execute as ReturnType<typeof vi.fn>;
    const reply = vi.fn(async () => {});
    const consumed = await tryDispatchDirective({
      registry,
      msg: msg({ text: '/steer abort' }),
      makeContext: async () => ({ channel: 'discord', peerId: 'x', sessionId: 's', agentLoop: null, toolRegistry: null, config: null, db: null }),
      reply,
      authorize: () => false,
    });
    expect(consumed).toBe(true);    // consumed → caller won't enqueue an agent turn
    expect(exec).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('ALLOW → command executes and replies', async () => {
    const registry = registryWithSpy();
    const exec = registry.get('steer')!.execute as ReturnType<typeof vi.fn>;
    const reply = vi.fn(async () => {});
    const consumed = await tryDispatchDirective({
      registry,
      msg: msg({ text: '/steer abort' }),
      makeContext: async () => ({ channel: 'discord', peerId: 'x', sessionId: 's', agentLoop: null, toolRegistry: null, config: null, db: null }),
      reply,
      authorize: () => true,
    });
    expect(consumed).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith('executed');
  });

  it('authorize that THROWS fails closed (deny)', async () => {
    const registry = registryWithSpy();
    const exec = registry.get('steer')!.execute as ReturnType<typeof vi.fn>;
    const consumed = await tryDispatchDirective({
      registry,
      msg: msg({ text: '/steer abort' }),
      makeContext: async () => ({ channel: 'discord', peerId: 'x', sessionId: 's', agentLoop: null, toolRegistry: null, config: null, db: null }),
      reply: vi.fn(async () => {}),
      authorize: () => { throw new Error('boom'); },
    });
    expect(consumed).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
});
