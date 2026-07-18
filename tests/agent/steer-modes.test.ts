/**
 * @file tests/agent/steer-modes.test.ts
 * @description GW-5 units — SteerBuffer (push/drain, overflow coalesce, min-tier),
 * decideQueueMode (exclusions + tier guard), and QueueModeStore precedence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SteerBuffer, minTier } from '../../src/core/agent/steer-buffer.js';
import {
  decideQueueMode,
  globalDefaultMode,
  QueueModeStore,
} from '../../src/core/channels/queue-modes.js';

describe('GW-5 SteerBuffer', () => {
  it('push then drain returns messages in order and clears', () => {
    const b = new SteerBuffer();
    b.push('s1', 'first', 'owner');
    b.push('s1', 'second', 'owner');
    expect(b.size('s1')).toBe(2);
    const drained = b.drain('s1');
    expect(drained.map((m) => m.text)).toEqual(['first', 'second']);
    expect(b.size('s1')).toBe(0);
    expect(b.drain('s1')).toEqual([]); // empty after drain
  });

  it('ignores empty/whitespace pushes', () => {
    const b = new SteerBuffer();
    b.push('s1', '   ', 'owner');
    b.push('s1', '', 'owner');
    expect(b.size('s1')).toBe(0);
  });

  it('overflow coalesces the oldest (never drops) — stays within cap', () => {
    const b = new SteerBuffer({ cap: 3 });
    b.push('s1', 'a', 'owner');
    b.push('s1', 'b', 'owner');
    b.push('s1', 'c', 'owner');
    b.push('s1', 'd', 'owner'); // 4th → over cap → coalesce oldest two
    expect(b.size('s1')).toBeLessThanOrEqual(3);
    const drained = b.drain('s1');
    // no message content is lost — 'a' and 'b' survive inside the coalesced head
    const joined = drained.map((m) => m.text).join(' ');
    expect(joined).toContain('a');
    expect(joined).toContain('b');
    expect(joined).toContain('c');
    expect(joined).toContain('d');
    expect(drained[0]?.coalesced).toBe(true);
  });

  it('coalesced summary inherits the LESS-trusted tier', () => {
    const b = new SteerBuffer({ cap: 1 });
    b.push('s1', 'owner-msg', 'owner');
    b.push('s1', 'untrusted-msg', 'untrusted'); // forces coalesce of the two
    const drained = b.drain('s1');
    expect(drained[0]?.tier).toBe('untrusted');
  });

  it('minTier returns the less-trusted tier', () => {
    expect(minTier('owner', 'untrusted')).toBe('untrusted');
    expect(minTier('owner', 'owner')).toBe('owner');
    expect(minTier('untrusted', 'untrusted')).toBe('untrusted');
  });
});

describe('GW-5 decideQueueMode', () => {
  const base = { mode: 'steer' as const, activeRun: true, isMedia: false, isCommand: false, runTier: 'owner' as const, msgTier: 'owner' as const };

  it('no active run → normal', () => {
    expect(decideQueueMode({ ...base, activeRun: false }).action).toBe('normal');
  });

  it('media → followup (never steered)', () => {
    expect(decideQueueMode({ ...base, isMedia: true }).action).toBe('followup');
  });

  it('registered command → followup (never folded into a run)', () => {
    expect(decideQueueMode({ ...base, isCommand: true }).action).toBe('followup');
  });

  it('steer allowed when msg tier >= run tier → steer with run tier', () => {
    const d = decideQueueMode({ ...base, runTier: 'owner', msgTier: 'owner' });
    expect(d.action).toBe('steer');
    if (d.action === 'steer') expect(d.tier).toBe('owner');
  });

  it('owner steering an untrusted run → steer, effective tier is min (untrusted)', () => {
    const d = decideQueueMode({ ...base, runTier: 'untrusted', msgTier: 'owner' });
    expect(d.action).toBe('steer');
    if (d.action === 'steer') expect(d.tier).toBe('untrusted');
  });

  it('TIER GUARD: untrusted steering an owner run → reroute to followup (never mix)', () => {
    const d = decideQueueMode({ ...base, runTier: 'owner', msgTier: 'untrusted' });
    expect(d.action).toBe('followup');
  });

  it('interrupt / collect / followup modes pass through when active', () => {
    expect(decideQueueMode({ ...base, mode: 'interrupt' }).action).toBe('interrupt');
    expect(decideQueueMode({ ...base, mode: 'collect' }).action).toBe('collect');
    expect(decideQueueMode({ ...base, mode: 'followup' }).action).toBe('followup');
  });
});

describe('GW-5 QueueModeStore + globalDefaultMode', () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'qm-')); saved = process.env['SUDO_QUEUE_MODE_DEFAULT']; delete process.env['SUDO_QUEUE_MODE_DEFAULT']; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); if (saved === undefined) delete process.env['SUDO_QUEUE_MODE_DEFAULT']; else process.env['SUDO_QUEUE_MODE_DEFAULT'] = saved; });

  it('global default is followup when SUDO_QUEUE_MODE_DEFAULT unset; honors valid override', () => {
    expect(globalDefaultMode({})).toBe('followup');
    expect(globalDefaultMode({ SUDO_QUEUE_MODE_DEFAULT: 'steer' })).toBe('steer');
    expect(globalDefaultMode({ SUDO_QUEUE_MODE_DEFAULT: 'bogus' })).toBe('followup');
  });

  it('resolve precedence: session override > channel default > global', () => {
    const store = new QueueModeStore(dir);
    expect(store.resolve('telegram', 'u1', {})).toBe('followup'); // global
    store.setChannelMode('telegram', 'collect');
    expect(store.resolve('telegram', 'u1', {})).toBe('collect'); // channel
    store.setSessionMode('telegram', 'u1', 'steer');
    expect(store.resolve('telegram', 'u1', {})).toBe('steer'); // session
    store.clearSessionMode('telegram', 'u1');
    expect(store.resolve('telegram', 'u1', {})).toBe('collect'); // back to channel
  });

  it('persists across instances', () => {
    const s1 = new QueueModeStore(dir);
    s1.setSessionMode('telegram', 'u1', 'interrupt');
    const s2 = new QueueModeStore(dir);
    expect(s2.resolve('telegram', 'u1', {})).toBe('interrupt');
  });
});
