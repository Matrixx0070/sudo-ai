/**
 * turn-identity registry — session→caller identity threaded onto ToolContext.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setTurnIdentity, getTurnIdentity, __resetTurnIdentityForTests } from '../../src/core/agent/turn-identity.js';

beforeEach(() => __resetTurnIdentityForTests());

describe('turn-identity', () => {
  it('records + returns identity for a session', () => {
    setTurnIdentity('s1', { isOwner: true, channel: 'web', peerId: 'web-1' });
    expect(getTurnIdentity('s1')).toEqual({ isOwner: true, channel: 'web', peerId: 'web-1' });
  });

  it('coerces isOwner to a strict boolean', () => {
    setTurnIdentity('s2', { isOwner: false, channel: 'telegram' });
    expect(getTurnIdentity('s2')?.isOwner).toBe(false);
  });

  it('latest write wins (session reused by a different driver)', () => {
    setTurnIdentity('s3', { isOwner: true, peerId: 'owner' });
    setTurnIdentity('s3', { isOwner: false, peerId: 'stranger' });
    expect(getTurnIdentity('s3')).toMatchObject({ isOwner: false, peerId: 'stranger' });
  });

  it('unknown session → undefined', () => {
    expect(getTurnIdentity('nope')).toBeUndefined();
  });

  it('ignores empty sessionId', () => {
    setTurnIdentity('', { isOwner: true });
    expect(getTurnIdentity('')).toBeUndefined();
  });
});
