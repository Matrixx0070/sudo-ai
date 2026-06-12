/**
 * @file tests/sessions/run-generation.test.ts
 * @description RunGenerationRegistry (gap #9) — invalidation tokens for
 * in-flight turns, and the /reset command bumping the generation so a stale
 * reply is discarded instead of delivered after the reset.
 */

import { describe, it, expect, vi } from 'vitest';
import { RunGenerationRegistry, runGenerations } from '../../src/core/sessions/run-generation.js';
import { resetCommand } from '../../src/core/commands/builtin/reset.js';
import type { CommandContext } from '../../src/core/commands/types.js';

function makeCtx(peerId: string, sessionManager: unknown): CommandContext {
  return {
    channel: 'telegram',
    peerId,
    sessionId: 'sess-old',
    agentLoop: { sessionManager },
    toolRegistry: null,
    config: null,
    db: null,
  } as CommandContext;
}

describe('RunGenerationRegistry', () => {
  it('defaults to generation 0 and isolates keys', () => {
    const reg = new RunGenerationRegistry();
    expect(reg.current('telegram:a')).toBe(0);
    expect(reg.bump('telegram:a')).toBe(1);
    expect(reg.current('telegram:a')).toBe(1);
    expect(reg.current('telegram:b')).toBe(0);
    expect(reg.current('discord:a')).toBe(0);
  });

  it('isStale reflects bumps that happened after capture', () => {
    const reg = new RunGenerationRegistry();
    const gen = reg.current('telegram:a');
    expect(reg.isStale('telegram:a', gen)).toBe(false);
    reg.bump('telegram:a');
    expect(reg.isStale('telegram:a', gen)).toBe(true);
    expect(reg.isStale('telegram:b', reg.current('telegram:b'))).toBe(false);
  });
});

describe('/reset bumps the run generation', () => {
  it('bumps after a successful archive so in-flight turns are invalidated', async () => {
    const peerId = `rg-peer-${Date.now()}-ok`;
    const key = `telegram:${peerId}`;
    const sessionManager = {
      archive: vi.fn(async () => undefined),
      getOrCreate: vi.fn(async () => ({ id: 'sess-new' })),
    };

    const before = runGenerations.current(key);
    const reply = await resetCommand.execute('', makeCtx(peerId, sessionManager));

    expect(reply).toContain('Session reset complete');
    expect(runGenerations.current(key)).toBe(before + 1);
    expect(runGenerations.isStale(key, before)).toBe(true);
  });

  it('does not bump when archiving fails (session continues unchanged)', async () => {
    const peerId = `rg-peer-${Date.now()}-fail`;
    const key = `telegram:${peerId}`;
    const sessionManager = {
      archive: vi.fn(async () => { throw new Error('disk full'); }),
      getOrCreate: vi.fn(async () => ({ id: 'sess-new' })),
    };

    const before = runGenerations.current(key);
    const reply = await resetCommand.execute('', makeCtx(peerId, sessionManager));

    expect(reply).toContain('Failed to archive session');
    expect(runGenerations.current(key)).toBe(before);
  });
});
