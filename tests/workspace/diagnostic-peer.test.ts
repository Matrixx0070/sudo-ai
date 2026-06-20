/**
 * @file diagnostic-peer.test.ts
 * @description Guards loopback/diagnostic peers out of the daily activity log so
 * local probes / health checks / manual gateway tests don't pollute the
 * "## Today" prompt injection. Opt-in via SUDO_SKIP_DIAGNOSTIC_DAILY_LOG.
 */

import { describe, it, expect } from 'vitest';
import {
  isDiagnosticPeer,
  shouldSkipDailyLog,
  shouldSkipDailyLogForMessage,
  diagnosticDailyLogSkipEnabled,
} from '../../src/core/workspace/diagnostic-peer.js';

const ON = { SUDO_SKIP_DIAGNOSTIC_DAILY_LOG: '1' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

describe('isDiagnosticPeer', () => {
  it('matches canonical loopback forms', () => {
    for (const id of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '0.0.0.0', 'localhost']) {
      expect(isDiagnosticPeer(id, OFF)).toBe(true);
    }
  });

  it('strips an IPv4 host:port before matching', () => {
    expect(isDiagnosticPeer('127.0.0.1:54822', OFF)).toBe(true);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(isDiagnosticPeer('  LOCALHOST  ', OFF)).toBe(true);
  });

  it('does NOT match real remote IPs or channel user IDs', () => {
    for (const id of ['203.0.113.7', '8.8.8.8', 'telegram-user-99', 'u_ABC123', '10.0.0.5']) {
      expect(isDiagnosticPeer(id, OFF)).toBe(false);
    }
  });

  it('never port-strips a bare IPv6 address (no false positive)', () => {
    expect(isDiagnosticPeer('2001:db8::1', OFF)).toBe(false);
  });

  it('returns false for empty / nullish peer IDs', () => {
    expect(isDiagnosticPeer(undefined, OFF)).toBe(false);
    expect(isDiagnosticPeer(null, OFF)).toBe(false);
    expect(isDiagnosticPeer('', OFF)).toBe(false);
    expect(isDiagnosticPeer('   ', OFF)).toBe(false);
  });

  it('honours the SUDO_DIAGNOSTIC_PEERS allowlist (case-insensitive, trimmed)', () => {
    const env = { SUDO_DIAGNOSTIC_PEERS: 'probe-bot, 192.168.1.50 ' } as NodeJS.ProcessEnv;
    expect(isDiagnosticPeer('PROBE-BOT', env)).toBe(true);
    expect(isDiagnosticPeer('192.168.1.50', env)).toBe(true);
    expect(isDiagnosticPeer('192.168.1.51', env)).toBe(false);
  });
});

describe('diagnosticDailyLogSkipEnabled', () => {
  it('is false by default and true only when the flag is exactly "1"', () => {
    expect(diagnosticDailyLogSkipEnabled(OFF)).toBe(false);
    expect(diagnosticDailyLogSkipEnabled({ SUDO_SKIP_DIAGNOSTIC_DAILY_LOG: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(diagnosticDailyLogSkipEnabled(ON)).toBe(true);
  });
});

describe('shouldSkipDailyLog (combined gate)', () => {
  it('skips a loopback peer ONLY when the flag is enabled', () => {
    expect(shouldSkipDailyLog('127.0.0.1', OFF)).toBe(false); // default off → never skip
    expect(shouldSkipDailyLog('127.0.0.1', ON)).toBe(true);
  });

  it('never skips a real peer even with the flag enabled', () => {
    expect(shouldSkipDailyLog('203.0.113.7', ON)).toBe(false);
    expect(shouldSkipDailyLog('telegram-user-99', ON)).toBe(false);
  });
});

describe('shouldSkipDailyLogForMessage (peerId OR peerIp)', () => {
  // The bug this fixes: web turns carry peerId 'web-<uuid>' (never a loopback
  // literal), so the peerId-only gate was a no-op on the web path — the socket
  // IP (peerIp) must be consulted.
  it('skips a loopback web client whose peerId is web-<uuid> (via peerIp)', () => {
    expect(shouldSkipDailyLog('web-abc123', ON)).toBe(false); // peerId alone never matches
    expect(shouldSkipDailyLogForMessage('web-abc123', '127.0.0.1', ON)).toBe(true);
    expect(shouldSkipDailyLogForMessage('web-abc123', '::ffff:127.0.0.1', ON)).toBe(true);
    expect(shouldSkipDailyLogForMessage('web-abc123', '::1', ON)).toBe(true);
  });

  it('does not skip a web client from a real remote IP', () => {
    expect(shouldSkipDailyLogForMessage('web-abc123', '203.0.113.7', ON)).toBe(false);
  });

  it('still matches a diagnostic peerId when peerIp is absent (non-web channels)', () => {
    expect(shouldSkipDailyLogForMessage('127.0.0.1', undefined, ON)).toBe(true);
    expect(shouldSkipDailyLogForMessage('telegram-user-99', undefined, ON)).toBe(false);
  });

  it('never skips when the flag is off, regardless of peerIp', () => {
    expect(shouldSkipDailyLogForMessage('web-abc123', '127.0.0.1', OFF)).toBe(false);
  });
});
