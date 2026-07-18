/**
 * GW-2: failover cost-cliff fix.
 *  - SustainedFailoverMonitor fires exactly one notice on sustained/multi-hop
 *    degradation, resets on primary recovery, and re-arms (no spam).
 *  - ModelFailover feeds the monitor from getNextProfile.
 *  - The config failover chain tries the cheap cache-friendly Grok tier BEFORE
 *    grok-4.5 (the expensive no-cache escalation).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import { SustainedFailoverMonitor } from '../../src/core/brain/failover-notice.js';
import { ModelFailover } from '../../src/core/brain/failover.js';

describe('GW-2 SustainedFailoverMonitor', () => {
  it('fires once after exceeding the hop threshold', () => {
    let t = 1000;
    const notices: number[] = [];
    const m = new SustainedFailoverMonitor({ now: () => t, notify: (n) => notices.push(n.consecutiveHops) });
    // 3 hops = threshold; 4th crosses (> hopThreshold default 3)
    for (let i = 0; i < 4; i++) m.noteSelection('xai-oauth/grok-4.5', false);
    expect(notices).toEqual([4]);
  });

  it('fires on sustained time even with few hops', () => {
    let t = 0;
    const notices: number[] = [];
    const m = new SustainedFailoverMonitor({ now: () => t, notify: () => notices.push(1) });
    m.noteSelection('alt', false); // streak starts at t=0
    t = 31_000; // > 30s
    m.noteSelection('alt', false);
    expect(notices).toHaveLength(1);
  });

  it('resets on primary recovery', () => {
    let t = 0;
    const notices: number[] = [];
    const m = new SustainedFailoverMonitor({ now: () => t, notify: () => notices.push(1) });
    for (let i = 0; i < 3; i++) m.noteSelection('alt', false);
    m.noteSelection('primary', true); // recovery
    expect(m.snapshot().consecutiveHops).toBe(0);
    expect(m.snapshot().onStreak).toBe(false);
    // A fresh streak must start over, not carry the old hop count.
    m.noteSelection('alt', false);
    expect(notices).toHaveLength(0);
  });

  it('re-arms — no spam within the re-arm window', () => {
    let t = 1000;
    const notices: number[] = [];
    const m = new SustainedFailoverMonitor({
      now: () => t,
      rearmMs: 60_000,
      notify: () => notices.push(1),
    });
    for (let i = 0; i < 4; i++) m.noteSelection('alt', false); // 1 notice
    t += 10_000;
    for (let i = 0; i < 4; i++) m.noteSelection('alt', false); // still in re-arm
    expect(notices).toHaveLength(1);
    t += 60_000; // past re-arm
    m.noteSelection('alt', false);
    expect(notices).toHaveLength(2);
  });

  it('swallows a throwing sink', () => {
    let t = 0;
    const m = new SustainedFailoverMonitor({
      now: () => t,
      notify: () => {
        throw new Error('boom');
      },
    });
    expect(() => {
      for (let i = 0; i < 4; i++) m.noteSelection('alt', false);
    }).not.toThrow();
  });
});

describe('GW-2 ModelFailover feeds the monitor', () => {
  it('notifies when selection stays off-primary', () => {
    const fo = new ModelFailover(['anthropic/claude-opus-4-8', 'xai-oauth/grok-4-fast-non-reasoning']);
    let t = 0;
    const notices: string[] = [];
    fo.setSustainedFailoverMonitor(
      new SustainedFailoverMonitor({ now: () => t, hopThreshold: 1, notify: (n) => notices.push(n.currentProfile) }),
    );
    // Cool down the primary so getNextProfile picks the secondary repeatedly.
    fo.recordError('anthropic/claude-opus-4-8', 'overloaded');
    fo.getNextProfile(); // secondary (non-primary), hop 1
    fo.getNextProfile(); // hop 2 > threshold 1 → fires
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(notices[0]).toBe('xai-oauth/grok-4-fast-non-reasoning');
  });
});

describe('GW-2 config failover chain order (cost cliff)', () => {
  it('cheap grok-4-fast tier precedes grok-4.5 in models.primary', () => {
    const cfgPath = path.resolve(__dirname, '../../config/sudo-ai.json5');
    const cfg = JSON5.parse(readFileSync(cfgPath, 'utf8')) as {
      models?: { primary?: Array<{ id: string }> };
    };
    const ids = (cfg.models?.primary ?? []).map((m) => m.id);
    const fastIdx = ids.indexOf('xai-oauth/grok-4-fast-non-reasoning');
    const bigIdx = ids.indexOf('xai-oauth/grok-4.5');
    expect(fastIdx).toBeGreaterThanOrEqual(0);
    expect(bigIdx).toBeGreaterThanOrEqual(0);
    expect(fastIdx).toBeLessThan(bigIdx);
  });
});
