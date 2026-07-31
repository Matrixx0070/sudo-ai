/**
 * TX6 — pinned live status card (SUDO_TG_STATUS_PIN). Pure card builder,
 * severity routing, min-gap throttle, and the controller lifecycle against
 * a fake transport (find-or-create, persistence, pin-once, health folding,
 * silent degradation on edit failure).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  renderStatusPinCard,
  shouldBubbleHealthAlert,
  createMinGapThrottle,
  createStatusPinController,
  readPinState,
  writePinState,
  type StatusPinSnapshot,
  type StatusPinDeps,
} from '../../src/core/channels/status-pin.js';

const NOW = 1_800_000_000_000;

function snap(over: Partial<StatusPinSnapshot> = {}): StatusPinSnapshot {
  return {
    nowMs: NOW,
    activity: { activeCount: 0 },
    cron: { enabledCount: 3, failingCount: 0 },
    spend: { todayUsd: 1.234, budgetUsd: 10 },
    health: { foldedCount: 0 },
    ...over,
  };
}

describe('renderStatusPinCard', () => {
  it('idle card: ≤12 lines with activity, cron, spend, health, timestamp', () => {
    const text = renderStatusPinCard(snap());
    const lines = text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(text).toContain('◉ **Sudo-Ai**');
    expect(text).toContain('🟢 idle');
    expect(text).toContain('⏰ Cron: 3 active · all green');
    expect(text).toContain('💸 Today: $1.23 / $10.00');
    expect(text).toContain('🩺 no incidents');
    expect(text).toMatch(/_updated \d{2}:\d{2} UTC_/);
  });

  it('working card shows oldest run key + elapsed + extra count', () => {
    const text = renderStatusPinCard(snap({
      activity: { activeCount: 2, oldestKey: 'telegram:123', oldestStartedAtMs: NOW - 40_000 },
    }));
    expect(text).toContain('🔶 working — telegram:123 · 40s (+1 more)');
  });

  it('failing cron + missing spend + incident line render defensively', () => {
    const text = renderStatusPinCard(snap({
      cron: { enabledCount: 5, failingCount: 1, lastFailureName: 'Nightly Self-Test' },
      spend: { todayUsd: null, budgetUsd: null },
      health: {
        foldedCount: 4,
        last: { severity: 'high', name: 'disk_space', message: 'Disk 88% full', kind: 'failure', atMs: NOW - 180_000 },
      },
    }));
    expect(text).toContain('⚠️ 1 failing (Nightly Self-Test)');
    expect(text).toContain('💸 Today: $? (no cap)');
    expect(text).toContain('🩺 disk_space HIGH 3m ago — Disk 88% full (×4)');
  });

  it('recovery incident renders as recovered', () => {
    const text = renderStatusPinCard(snap({
      health: {
        foldedCount: 1,
        last: { severity: 'high', name: 'disk_space', message: 'Disk 70% full', kind: 'recovery', atMs: NOW - 5_000 },
      },
    }));
    expect(text).toContain('disk_space recovered 5s ago');
  });
});

describe('shouldBubbleHealthAlert (severity routing)', () => {
  it('critical failures ALWAYS bubble', () => {
    expect(shouldBubbleHealthAlert('critical', 'failure')).toBe(true);
  });
  it('high failures and all recoveries fold into the card', () => {
    expect(shouldBubbleHealthAlert('high', 'failure')).toBe(false);
    expect(shouldBubbleHealthAlert('high', 'recovery')).toBe(false);
    expect(shouldBubbleHealthAlert('critical', 'recovery')).toBe(false);
  });
});

describe('createMinGapThrottle', () => {
  it('first acquire succeeds; re-acquire blocked until the gap elapses', () => {
    let t = 100_000;
    const th = createMinGapThrottle(15_000, () => t);
    expect(th.tryAcquire()).toBe(true);
    expect(th.tryAcquire()).toBe(false);
    t += 14_999;
    expect(th.tryAcquire()).toBe(false);
    expect(th.msUntilReady()).toBe(1);
    t += 1;
    expect(th.tryAcquire()).toBe(true);
    expect(th.tryAcquire()).toBe(false);
  });
});

describe('pin state persistence', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'status-pin-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips {chatId, messageId} and tolerates missing/corrupt files', () => {
    const file = path.join(dir, 'nested', 'status-pin.json');
    expect(readPinState(file)).toBeNull();
    writePinState(file, { chatId: '42', messageId: '777' });
    expect(readPinState(file)).toEqual({ chatId: '42', messageId: '777' });
    writeFileSync(file, 'not json', 'utf8');
    expect(readPinState(file)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

interface Fake {
  sends: string[];
  edits: Array<{ id: string | number; text: string }>;
  pins: Array<string | number>;
  deps: StatusPinDeps;
  clock: { t: number };
}

function makeFake(dir: string, over: Partial<StatusPinDeps> = {}): Fake {
  const clock = { t: NOW };
  const sends: string[] = [];
  const edits: Array<{ id: string | number; text: string }> = [];
  const pins: Array<string | number> = [];
  const deps: StatusPinDeps = {
    chatId: '42',
    stateFile: path.join(dir, 'status-pin.json'),
    send: async (_c, text) => { sends.push(text); return `msg-${sends.length}`; },
    edit: async (_c, id, text) => { edits.push({ id, text }); },
    pin: async (_c, id) => { pins.push(id); },
    collect: async () => ({
      activity: { activeCount: 0 },
      cron: { enabledCount: 1, failingCount: 0 },
      spend: { todayUsd: 0.5, budgetUsd: null },
    }),
    now: () => clock.t,
    ...over,
  };
  return { sends, edits, pins, deps, clock };
}

describe('createStatusPinController', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'status-pin-ctl-')); });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  it('start: creates, pins ONCE, persists the message id', async () => {
    const f = makeFake(dir);
    const ctl = createStatusPinController(f.deps);
    await ctl.start();
    expect(f.sends).toHaveLength(1);
    expect(f.pins).toEqual(['msg-1']);
    expect(ctl.messageId).toBe('msg-1');
    expect(readPinState(f.deps.stateFile)).toEqual({ chatId: '42', messageId: 'msg-1' });
    ctl.stop();
  });

  it('start: reuses a persisted message id (edit, no new send, no re-pin)', async () => {
    writePinState(path.join(dir, 'status-pin.json'), { chatId: '42', messageId: '999' });
    const f = makeFake(dir);
    const ctl = createStatusPinController(f.deps);
    await ctl.start();
    expect(f.sends).toHaveLength(0);
    expect(f.pins).toHaveLength(0);
    expect(f.edits[0]?.id).toBe('999');
    expect(ctl.messageId).toBe('999');
    ctl.stop();
  });

  it('start: stale persisted id (edit rejects) → recreates + pins + re-persists', async () => {
    writePinState(path.join(dir, 'status-pin.json'), { chatId: '42', messageId: '999' });
    const f = makeFake(dir);
    let first = true;
    f.deps.edit = async (_c, id, text) => {
      if (first && id === '999') { first = false; throw new Error('message to edit not found'); }
      f.edits.push({ id, text });
    };
    const ctl = createStatusPinController(f.deps);
    await ctl.start();
    expect(ctl.messageId).toBe('msg-1');
    expect(f.pins).toEqual(['msg-1']);
    expect(readPinState(f.deps.stateFile)).toEqual({ chatId: '42', messageId: 'msg-1' });
    ctl.stop();
  });

  it('bump: refreshes with min-gap throttle (second bump within the gap coalesces)', async () => {
    vi.useFakeTimers();
    const f = makeFake(dir);
    const ctl = createStatusPinController({ ...f.deps, minGapMs: 15_000, intervalMs: 60_000 });
    await ctl.start();
    ctl.bump('run-change'); // first edit — throttle acquires
    await vi.advanceTimersByTimeAsync(1);
    expect(f.edits).toHaveLength(1);
    f.clock.t += 1_000;
    ctl.bump('run-change'); // inside the gap → deferred, not dropped
    await vi.advanceTimersByTimeAsync(1);
    expect(f.edits).toHaveLength(1);
    f.clock.t += 15_000;
    await vi.advanceTimersByTimeAsync(15_100); // retry timer fires after the gap
    expect(f.edits).toHaveLength(2);
    ctl.stop();
  });

  it('cadence: interval timer refreshes the card', async () => {
    vi.useFakeTimers();
    const f = makeFake(dir);
    const ctl = createStatusPinController({ ...f.deps, minGapMs: 15_000, intervalMs: 60_000 });
    await ctl.start();
    f.clock.t += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.edits.length).toBeGreaterThanOrEqual(1);
    ctl.stop();
  });

  it('recordHealthAlert: incident + count land on the card', async () => {
    vi.useFakeTimers();
    const f = makeFake(dir);
    const ctl = createStatusPinController({ ...f.deps, minGapMs: 0 });
    await ctl.start();
    ctl.recordHealthAlert('high', 'disk_space', 'Disk 88% full', 'failure');
    await vi.advanceTimersByTimeAsync(1);
    ctl.recordHealthAlert('high', 'disk_space', 'Disk 88% full', 'failure');
    await vi.advanceTimersByTimeAsync(1);
    const last = f.edits[f.edits.length - 1]!.text;
    expect(last).toContain('disk_space HIGH');
    expect(last).toContain('Disk 88% full');
    expect(last).toContain('(×2)');
    ctl.stop();
  });

  it('edit failures degrade silently (no throw, later edits still try)', async () => {
    vi.useFakeTimers();
    const f = makeFake(dir);
    let calls = 0;
    f.deps.edit = async () => { calls++; if (calls === 1) throw new Error('403'); };
    const ctl = createStatusPinController({ ...f.deps, minGapMs: 0 });
    await ctl.start(); // created via send; first EDIT comes from bump below
    ctl.bump('a');
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(1); // failed silently
    ctl.bump('b');
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2); // still trying
    ctl.stop();
  });

  it('start failure (send rejects) degrades to a no-card controller', async () => {
    const f = makeFake(dir);
    f.deps.send = async () => { throw new Error('bot down'); };
    const ctl = createStatusPinController(f.deps);
    await expect(ctl.start()).resolves.toBeUndefined();
    expect(ctl.messageId).toBeNull();
    ctl.bump('noop'); // safe on a dead controller
    ctl.stop();
  });

  it('stop: cadence halts (no further edits)', async () => {
    vi.useFakeTimers();
    const f = makeFake(dir);
    const ctl = createStatusPinController({ ...f.deps, minGapMs: 0, intervalMs: 1_000 });
    await ctl.start();
    ctl.stop();
    f.clock.t += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.edits).toHaveLength(0);
    const before = f.edits.length;
    ctl.bump('after-stop');
    await vi.advanceTimersByTimeAsync(1);
    expect(f.edits.length).toBe(before);
  });
});

/**
 * 2026-07-29: three of four brain profiles were down for hours — an Anthropic
 * ORG-level OAuth 403 (permanently disabled) plus 429 quota walls on google and
 * openai — with ollama/glm-5.2 carrying everything alone, one blip from total
 * outage. The pinned card reported "Cron: 24 active · all green" throughout.
 * Cron health was visible; the thing that actually takes the product down was
 * not. Diagnosis needed a 90-second probe nobody thought to run for hours.
 */
describe('renderStatusPinCard — brain chain health', () => {
  it('stays quiet when every provider is healthy', () => {
    const out = renderStatusPinCard(snap({ brain: { profileCount: 4, availableCount: 4, disabledCount: 0, coolingCount: 0 } }));
    expect(out).toContain('🧠 Brain: 4/4 providers');
    expect(out).not.toContain('⚠️');
  });

  it('shows the real shape of the 2026-07-29 outage', () => {
    const out = renderStatusPinCard(snap({ brain: { profileCount: 4, availableCount: 1, disabledCount: 1, coolingCount: 2 } }));
    expect(out).toContain('🧠 Brain: ⚠️ 1/4 available');
    expect(out).toContain('1 disabled');
    expect(out).toContain('2 cooling');
  });

  it('screams when nothing can serve', () => {
    const out = renderStatusPinCard(snap({ brain: { profileCount: 4, availableCount: 0, disabledCount: 3, coolingCount: 1 } }));
    expect(out).toContain('🔴 NO provider available');
    expect(out).toContain('3 disabled');
  });

  it('is omitted entirely when no brain snapshot is supplied (back-compat)', () => {
    expect(renderStatusPinCard(snap())).not.toContain('🧠 Brain');
  });

  it('brain health is rendered ABOVE cron — outage beats housekeeping', () => {
    const out = renderStatusPinCard(snap({ brain: { profileCount: 4, availableCount: 0, disabledCount: 4, coolingCount: 0 } }));
    expect(out.indexOf('🧠 Brain')).toBeLessThan(out.indexOf('⏰ Cron'));
  });

  // ADR 0003: slot counts overstate redundancy (4 of 6 prod slots share ONE
  // Anthropic credential). The card reports failure DOMAINS when supplied.
  it('renders domain counts when supplied', () => {
    const out = renderStatusPinCard(snap({
      brain: { profileCount: 6, availableCount: 6, disabledCount: 0, coolingCount: 0, domainCount: 3, domainsUpCount: 3 },
    }));
    expect(out).toContain('🧠 Brain: 6/6 providers · domains 3/3');
  });

  it('warns on ONE domain up even when several slots look available', () => {
    // 2026-07-29 shape: glm + a cooling-but-technically-back gemini slot could
    // read "2 available" while every serving profile sat in one credential
    // domain away from total outage.
    const out = renderStatusPinCard(snap({
      brain: { profileCount: 6, availableCount: 2, disabledCount: 1, coolingCount: 3, domainCount: 3, domainsUpCount: 1 },
    }));
    expect(out).toContain('⚠️');
    expect(out).toContain('· domains 1/3');
  });

  it('does NOT warn when 2+ domains are up despite degraded slots', () => {
    const out = renderStatusPinCard(snap({
      brain: { profileCount: 6, availableCount: 2, disabledCount: 4, coolingCount: 0, domainCount: 3, domainsUpCount: 2 },
    }));
    expect(out).toContain('4 disabled');
    expect(out).not.toContain('⚠️');
  });

  it('falls back to slot-count warning when domain info is absent (back-compat)', () => {
    const out = renderStatusPinCard(snap({ brain: { profileCount: 4, availableCount: 1, disabledCount: 1, coolingCount: 2 } }));
    expect(out).toContain('⚠️ 1/4 available');
    expect(out).not.toContain('· domains');
  });
});

describe('renderStatusPinCard — context pressure (statusline parity)', () => {
  it('omits the context line entirely when unknown', () => {
    expect(renderStatusPinCard(snap())).not.toContain('Context:');
  });

  it('renders percent and k-formatted usage', () => {
    const text = renderStatusPinCard(snap({ context: { usedTokens: 120_000, windowTokens: 200_000 } }));
    expect(text).toContain('🪟 Context: 60% (120k/200k)');
  });

  it('stays calm below 75% and escalates markers above it', () => {
    expect(renderStatusPinCard(snap({ context: { usedTokens: 10, windowTokens: 100 } }))).toContain('Context: 10%');
    expect(renderStatusPinCard(snap({ context: { usedTokens: 80, windowTokens: 100 } }))).toContain('⚠️ 80%');
    expect(renderStatusPinCard(snap({ context: { usedTokens: 95, windowTokens: 100 } }))).toContain('🔴 95%');
  });

  it('never exceeds 100% or divides by zero', () => {
    expect(renderStatusPinCard(snap({ context: { usedTokens: 500, windowTokens: 100 } }))).toContain('100%');
    expect(renderStatusPinCard(snap({ context: { usedTokens: 5, windowTokens: 0 } }))).not.toContain('Context:');
  });

  it('keeps the card within its 12-line budget with context present', () => {
    const text = renderStatusPinCard(snap({
      context: { usedTokens: 1000, windowTokens: 200_000 },
      activity: { activeCount: 2, oldestKey: 'telegram:1', oldestStartedAtMs: NOW - 60_000 },
      cron: { enabledCount: 3, failingCount: 1, lastFailureName: 'job' },
    }));
    expect(text.split('\n').length).toBeLessThanOrEqual(12);
  });
});
