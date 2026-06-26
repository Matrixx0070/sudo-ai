/**
 * @file tests/commands/registry-idempotent.test.ts
 * @description CommandRegistry.register idempotency: re-registering the SAME
 * SlashCommand object (the real boot duplication, where a command arrives via
 * more than one path that imports the same ES-module singleton) is a no-op, while
 * a genuinely divergent same-name re-register still wins last.
 */

import { describe, it, expect } from 'vitest';
import { CommandRegistry } from '../../src/core/commands/registry.js';
import type { SlashCommand } from '../../src/core/commands/types.js';

function makeCommand(name: string, marker = name): SlashCommand {
  return {
    name,
    description: `Mock command: ${name}`,
    usage: `/${name}`,
    execute: async () => marker,
  };
}

describe('CommandRegistry — idempotent same-reference registration', () => {
  it('re-registering the SAME object reference is a no-op (count unchanged)', () => {
    const registry = new CommandRegistry();
    const cmd = makeCommand('status');
    registry.register(cmd);
    registry.register(cmd);
    registry.register(cmd);
    expect(registry.listAll()).toHaveLength(1);
    expect(registry.get('status')).toBe(cmd);
  });

  it('a DIVERGENT same-name re-register still wins last (behavior preserved)', () => {
    const registry = new CommandRegistry();
    const first = makeCommand('status', 'first');
    const second = makeCommand('status', 'second');
    registry.register(first);
    registry.register(second);
    expect(registry.listAll()).toHaveLength(1);
    expect(registry.get('status')).toBe(second);
  });
});
