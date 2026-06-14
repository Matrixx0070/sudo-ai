/**
 * Tests for HeartbeatDedup — drops replayed heartbeat content inside a
 * sliding window so the agent doesn't burn turns acknowledging dupes.
 */

import { describe, it, expect } from 'vitest';
import {
  HeartbeatDedup,
  hashHeartbeatMessage,
  normaliseHeartbeatMessage,
  DEFAULT_HEARTBEAT_DEDUP_WINDOW_MS,
} from '../../src/core/cron/heartbeat-dedup.js';

describe('normaliseHeartbeatMessage', () => {
  it('strips ISO-8601 timestamp lines so per-tick decoration does not break dedup', () => {
    const a = '[HEARTBEAT @ 2026-06-14T22:00:00Z]\n## Today\nKey facts: alpha';
    const b = '[HEARTBEAT @ 2026-06-14T22:01:00Z]\n## Today\nKey facts: alpha';
    expect(normaliseHeartbeatMessage(a)).toBe(normaliseHeartbeatMessage(b));
  });

  it('preserves real content differences', () => {
    const a = '## Today\nFact: alpha';
    const b = '## Today\nFact: beta';
    expect(normaliseHeartbeatMessage(a)).not.toBe(normaliseHeartbeatMessage(b));
  });
});

describe('hashHeartbeatMessage', () => {
  it('produces a stable 16-char hex hash', () => {
    const h = hashHeartbeatMessage('hello world');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
  it('hashes equal-after-normalisation messages identically', () => {
    expect(hashHeartbeatMessage('alpha\n[HEARTBEAT @ 2026-06-14T22:00:00Z]\nbeta'))
      .toBe(hashHeartbeatMessage('alpha\n[HEARTBEAT @ 2026-06-14T23:00:00Z]\nbeta'));
  });
});

describe('HeartbeatDedup', () => {
  it('lets the first sighting through', () => {
    const d = new HeartbeatDedup();
    const r = d.check('## Today\nfact: x');
    expect(r.shouldProcess).toBe(true);
    expect(r.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.firstSeenAt).toBeUndefined();
  });

  it('drops a repeat inside the window', () => {
    let now = 1_000_000;
    const d = new HeartbeatDedup(60_000, () => now);
    const first = d.check('## Today\nfact: x');
    expect(first.shouldProcess).toBe(true);
    now += 30_000;
    const dupe = d.check('## Today\nfact: x');
    expect(dupe.shouldProcess).toBe(false);
    expect(dupe.firstSeenAt).toBe(1_000_000);
    expect(dupe.hash).toBe(first.hash);
  });

  it('lets the message through again once the window has passed', () => {
    let now = 1_000_000;
    const d = new HeartbeatDedup(60_000, () => now);
    expect(d.check('## Today\nfact: x').shouldProcess).toBe(true);
    now += 60_001;
    expect(d.check('## Today\nfact: x').shouldProcess).toBe(true);
  });

  it('treats timestamp-only differences as duplicates', () => {
    const d = new HeartbeatDedup();
    const a = '[HEARTBEAT @ 2026-06-14T22:00:00Z]\nfact: alpha';
    const b = '[HEARTBEAT @ 2026-06-14T22:01:00Z]\nfact: alpha';
    expect(d.check(a).shouldProcess).toBe(true);
    expect(d.check(b).shouldProcess).toBe(false);
  });

  it('treats real content changes as new entries', () => {
    const d = new HeartbeatDedup();
    expect(d.check('## Today\nfact: alpha').shouldProcess).toBe(true);
    expect(d.check('## Today\nfact: beta').shouldProcess).toBe(true);
  });

  it('refreshes the timestamp on each hit so a burst does not expire mid-flight', () => {
    let now = 1_000_000;
    const d = new HeartbeatDedup(60_000, () => now);
    d.check('msg');                  // seen
    now += 40_000;
    expect(d.check('msg').shouldProcess).toBe(false); // refreshes
    now += 40_000; // 80s since original, but only 40s since refresh
    expect(d.check('msg').shouldProcess).toBe(false); // still inside window
  });

  it('exposes a default window suitable for production', () => {
    expect(DEFAULT_HEARTBEAT_DEDUP_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});
