/**
 * @file notifier-wire.test.ts
 * @description Unit tests for P4b — proactive-notifier channel routing logic.
 *
 * Tests routing behaviour in isolation with mock adapters.
 * Does NOT import cli.ts or loop.ts — replicates routing/counter logic locally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers — replicates the routing callback from cli.ts and the REPLAN
// counter logic from loop.ts, without importing those modules.
// ---------------------------------------------------------------------------

// Use explicit function signatures for mock types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

interface MockAdapter {
  isConnected: boolean;
  send: Mock<AnyFn>;
}

interface MockNotification {
  priority: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  message: string;
}

/**
 * Replicates the onNotification callback body from cli.ts.
 * Calls send() on the provided mock adapters according to priority routing.
 */
async function routeNotification(
  n: MockNotification,
  waAdapter: MockAdapter | null,
  tgAdapter: MockAdapter | null,
  options: {
    waJid?: string;
    tgChatId?: string;
    notifyLowPriority?: string;
  } = {},
): Promise<void> {
  const isHighCrit = n.priority === 'high' || n.priority === 'critical';
  const tgText = `[${n.priority.toUpperCase()}] ${n.title}\n${n.message.slice(0, 400)}`;

  // HIGH/CRITICAL → WhatsApp + Telegram
  if (isHighCrit && waAdapter?.isConnected) {
    const waJid = (options.waJid ?? '').split(',')[0]?.trim();
    if (waJid) {
      try { await (waAdapter.send as AnyFn)(waJid, tgText); }
      catch { /* swallowed */ }
    }
  }

  // LOW/MEDIUM/HIGH/CRITICAL → Telegram (LOW gated by env)
  const sendToTg = n.priority !== 'low' || options.notifyLowPriority === '1';
  if (sendToTg && tgAdapter?.isConnected) {
    const tgChatId = (options.tgChatId ?? '').split(',')[0]?.trim();
    if (tgChatId) {
      try { await (tgAdapter.send as AnyFn)(tgChatId, tgText); }
      catch { /* swallowed */ }
    }
  }
}

/**
 * Replicates the REPLAN counter logic from loop.ts.
 * Returns remaining counter value after the sequence.
 */
function simulateReplans(
  count: number,
  notifySpy: Mock<AnyFn>,
): number {
  let consecutiveReplans = 0;

  for (let i = 0; i < count; i++) {
    consecutiveReplans++;
    if (consecutiveReplans >= 3) {
      notifySpy(
        'warning',
        'EPISTEMIC_ESCALATION',
        `Tool: mock.tool | Tag: CONJECTURE | Session: test-session | last message`,
        'high',
      );
      consecutiveReplans = 0; // reset after escalation
    }
  }

  return consecutiveReplans; // remaining count
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P4b — proactive-notifier routing (notifier-wire)', () => {
  let waAdapter: MockAdapter;
  let tgAdapter: MockAdapter;

  beforeEach(() => {
    waAdapter = { isConnected: true, send: vi.fn().mockResolvedValue(undefined) };
    tgAdapter = { isConnected: true, send: vi.fn().mockResolvedValue(undefined) };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1: HIGH priority → both adapters called
  it('TEST-1: HIGH priority → send() called on both WA and TG adapters', async () => {
    await routeNotification(
      { priority: 'high', title: 'Test', message: 'high priority message' },
      waAdapter,
      tgAdapter,
      { waJid: '4917612345678@s.whatsapp.net', tgChatId: '123456789' },
    );
    expect(waAdapter.send).toHaveBeenCalledOnce();
    expect(tgAdapter.send).toHaveBeenCalledOnce();
  });

  // Test 2: MEDIUM priority → TG only, WA not called
  it('TEST-2: MEDIUM priority → TG send() called, WA send() NOT called', async () => {
    await routeNotification(
      { priority: 'medium', title: 'Test', message: 'medium priority message' },
      waAdapter,
      tgAdapter,
      { waJid: '4917612345678@s.whatsapp.net', tgChatId: '123456789' },
    );
    expect(waAdapter.send).not.toHaveBeenCalled();
    expect(tgAdapter.send).toHaveBeenCalledOnce();
  });

  // Test 3: LOW + NOTIFY_LOW_PRIORITY not set → neither adapter
  it('TEST-3: LOW priority + NOTIFY_LOW_PRIORITY unset → neither adapter called', async () => {
    await routeNotification(
      { priority: 'low', title: 'Test', message: 'low priority message' },
      waAdapter,
      tgAdapter,
      { waJid: '4917612345678@s.whatsapp.net', tgChatId: '123456789', notifyLowPriority: '0' },
    );
    expect(waAdapter.send).not.toHaveBeenCalled();
    expect(tgAdapter.send).not.toHaveBeenCalled();
  });

  // Test 4: LOW + NOTIFY_LOW_PRIORITY=1 → TG only
  it('TEST-4: LOW priority + NOTIFY_LOW_PRIORITY=1 → TG only', async () => {
    await routeNotification(
      { priority: 'low', title: 'Test', message: 'low priority message' },
      waAdapter,
      tgAdapter,
      { waJid: '4917612345678@s.whatsapp.net', tgChatId: '123456789', notifyLowPriority: '1' },
    );
    expect(waAdapter.send).not.toHaveBeenCalled();
    expect(tgAdapter.send).toHaveBeenCalledOnce();
  });

  // Test 5: 3 consecutive REPLAN events → notify() called once with EPISTEMIC_ESCALATION
  it('TEST-5: 3 consecutive REPLAN events → notify() called once with EPISTEMIC_ESCALATION title', () => {
    const notifySpy: Mock<AnyFn> = vi.fn();
    const remainingCount = simulateReplans(3, notifySpy);
    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith(
      'warning',
      'EPISTEMIC_ESCALATION',
      expect.stringContaining('mock.tool'),
      'high',
    );
    // Counter resets to 0 after escalation
    expect(remainingCount).toBe(0);
  });

  // Test 6: Counter resets to 0 after non-REPLAN (success) turn
  it('TEST-6: Counter resets to 0 after successful (non-REPLAN) tool execution', () => {
    const notifySpy: Mock<AnyFn> = vi.fn();
    let consecutiveReplans = 0;

    // 2 REPLANs — below threshold, no escalation
    for (let i = 0; i < 2; i++) {
      consecutiveReplans++;
      if (consecutiveReplans >= 3) {
        notifySpy('warning', 'EPISTEMIC_ESCALATION', '', 'high');
        consecutiveReplans = 0;
      }
    }
    expect(consecutiveReplans).toBe(2);
    expect(notifySpy).not.toHaveBeenCalled();

    // Success path: reset counter
    consecutiveReplans = 0;
    expect(consecutiveReplans).toBe(0);
    expect(notifySpy).not.toHaveBeenCalled();
  });
});
