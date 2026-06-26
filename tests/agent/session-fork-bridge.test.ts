/**
 * @file session-fork-bridge.test.ts
 * @description The three fork-path boundary bridges must be identity-preserving:
 * each returns the SAME object reference it was given, only re-typed. The loop
 * reassigns its live `session` through these and then mutates/persists it, so a
 * bridge that copied would silently drop the turn's messages.
 */

import { describe, it, expect } from 'vitest';
import {
  toForkSession,
  toForkSessionManager,
  fromForkSession,
} from '../../src/core/agent/session-fork-bridge.js';

describe('session-fork-bridge — identity-preserving boundary bridges', () => {
  it('toForkSession returns the same reference', () => {
    const session = { id: 's1', messages: [{ role: 'user', content: 'hi' }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(toForkSession(session as any)).toBe(session);
  });

  it('toForkSessionManager returns the same reference', () => {
    const manager = {
      get: async () => undefined,
      save: async () => {},
      archive: async () => {},
      getOrCreate: async () => ({ id: 'x', messages: [] }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(toForkSessionManager(manager as any)).toBe(manager);
  });

  it('fromForkSession returns the same reference', () => {
    const session = {
      id: 's2',
      channel: 'web',
      peerId: 'p1',
      state: 'active',
      messages: [],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(fromForkSession(session as any)).toBe(session);
  });

  it('a mutation through the bridged view lands on the original object', () => {
    const session = { id: 's3', messages: [] as Array<{ role: string; content: string }> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridged = toForkSession(session as any);
    bridged.messages.push({ role: 'system', content: 'fork notice' });
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.content).toBe('fork notice');
  });
});
