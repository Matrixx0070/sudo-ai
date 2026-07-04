/**
 * committed-outbound registry — per-session evidence that a turn performed an
 * external side effect, feeding AgentRunResult.committedOutbound and the
 * task-queue auto-retry gate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  isOutboundToolName,
  markCommittedOutbound,
  hasCommittedOutbound,
  clearCommittedOutbound,
} from '../../src/core/agent/committed-outbound.js';

const SID = 'sess-committed-outbound-test';
afterEach(() => clearCommittedOutbound(SID));

describe('isOutboundToolName', () => {
  it('flags every comms tool and the send/spawn/cron tools', () => {
    for (const n of ['comms.slack', 'comms.gmail', 'comms.notify', 'comms.webhook', 'message.send', 'sessions.spawn', 'cron.create']) {
      expect(isOutboundToolName(n)).toBe(true);
    }
  });
  it('does NOT flag read-only / local tools', () => {
    for (const n of ['coder.read-file', 'system.exec', 'browser.search', 'comms.imessage'.replace('comms.imessage', 'imessage.read'), 'meta.health-check']) {
      expect(isOutboundToolName(n)).toBe(false);
    }
  });
  it('is safe on non-string input', () => {
    expect(isOutboundToolName(undefined as unknown as string)).toBe(false);
  });
});

describe('committed-outbound registry', () => {
  it('mark → has → clear round-trips per session', () => {
    expect(hasCommittedOutbound(SID)).toBe(false);
    markCommittedOutbound(SID);
    expect(hasCommittedOutbound(SID)).toBe(true);
    clearCommittedOutbound(SID);
    expect(hasCommittedOutbound(SID)).toBe(false);
  });
  it('is a no-op for empty/undefined session ids', () => {
    markCommittedOutbound(undefined);
    markCommittedOutbound('');
    expect(hasCommittedOutbound(undefined)).toBe(false);
    expect(hasCommittedOutbound('')).toBe(false);
  });
  it('isolates sessions', () => {
    markCommittedOutbound(SID);
    expect(hasCommittedOutbound('other-session')).toBe(false);
  });
});
