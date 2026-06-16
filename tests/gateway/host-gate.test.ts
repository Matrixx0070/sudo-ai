/**
 * @file host-gate.test.ts
 * @description Tests for the gateway SSRF / DNS-rebinding Host-header gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isHostGateEnabled,
  isHostAllowed,
  getAllowlist,
} from '../../src/core/gateway/host-gate.js';

const FLAG = 'SUDO_SSRF_HOST_GATE';
const EXTRA = 'SUDO_SSRF_ALLOWED_HOSTS';

let savedFlag: string | undefined;
let savedExtra: string | undefined;
beforeEach(() => {
  savedFlag = process.env[FLAG];
  savedExtra = process.env[EXTRA];
  delete process.env[FLAG];
  delete process.env[EXTRA];
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  if (savedExtra === undefined) delete process.env[EXTRA];
  else process.env[EXTRA] = savedExtra;
});

describe('isHostGateEnabled', () => {
  it('is ON by default (defense, not opt-in)', () => {
    expect(isHostGateEnabled()).toBe(true);
  });
  it('only "0" disables — "false"/"off"/empty do not', () => {
    for (const v of ['false', 'off', 'no', '', 'FALSE']) {
      process.env[FLAG] = v;
      expect(isHostGateEnabled()).toBe(true);
    }
    process.env[FLAG] = '0';
    expect(isHostGateEnabled()).toBe(false);
  });
});

describe('getAllowlist', () => {
  it('returns the defaults when SUDO_SSRF_ALLOWED_HOSTS is unset', () => {
    const list = getAllowlist();
    expect(list).toContain('127.0.0.1');
    expect(list).toContain('localhost');
    expect(list).toContain('::1');
    expect(list.length).toBe(3);
  });
  it('extends with comma-separated env entries (trimmed, lowercased)', () => {
    process.env[EXTRA] = 'peer1.example.com, PEER2.example.com ,';
    const list = getAllowlist();
    expect(list).toContain('peer1.example.com');
    expect(list).toContain('peer2.example.com');
    expect(list.length).toBe(5);
  });
  it('ignores empty entries and whitespace-only entries', () => {
    process.env[EXTRA] = ',, , ,';
    expect(getAllowlist().length).toBe(3);
  });
});

describe('isHostAllowed — positive cases (default allowlist)', () => {
  it.each([
    '127.0.0.1:18900',
    'localhost:18900',
    '[::1]:18900',
    '127.0.0.1', // no port
    'localhost',
    '127.0.0.1:65535', // any port — comparison is hostname-only
    'LOCALHOST:18900', // case insensitive
    'Localhost:18900',
  ])('allowed: %s', (host) => {
    expect(isHostAllowed(host)).toBe(true);
  });
});

describe('isHostAllowed — DNS-rebinding attempts (default allowlist)', () => {
  it.each([
    'evil.com:18900',
    'evil.com',
    'evil.com.127.0.0.1:18900', // suffix trick
    '127.0.0.1.evil.com:18900', // prefix trick (parsed as hostname "127.0.0.1.evil.com")
    'attacker.example:18900',
    '0.0.0.0:18900', // not in allowlist
    '10.0.0.5:18900', // private IP, but not 127.0.0.1
    '[::2]:18900', // not loopback
  ])('rejected: %s', (host) => {
    expect(isHostAllowed(host)).toBe(false);
  });
});

describe('isHostAllowed — defensive inputs', () => {
  it('rejects undefined / null / non-string', () => {
    expect(isHostAllowed(undefined)).toBe(false);
    expect(isHostAllowed(null as unknown as string)).toBe(false);
    expect(isHostAllowed(123 as unknown as string)).toBe(false);
  });
  it('rejects empty / whitespace-only', () => {
    expect(isHostAllowed('')).toBe(false);
    expect(isHostAllowed('   ')).toBe(false);
  });
});

describe('isHostAllowed — env-extended allowlist', () => {
  it('accepts a host added via SUDO_SSRF_ALLOWED_HOSTS', () => {
    process.env[EXTRA] = 'peer.internal,backup.internal';
    expect(isHostAllowed('peer.internal:18900')).toBe(true);
    expect(isHostAllowed('backup.internal')).toBe(true);
    expect(isHostAllowed('PEER.INTERNAL:18900')).toBe(true); // case
    expect(isHostAllowed('other.internal:18900')).toBe(false); // not added
  });
});

describe('isHostAllowed — IPv6 bracket and port handling', () => {
  it('strips IPv6 brackets and port', () => {
    expect(isHostAllowed('[::1]:18900')).toBe(true);
    expect(isHostAllowed('[::1]')).toBe(true);
  });
  it('does NOT accept non-loopback IPv6', () => {
    expect(isHostAllowed('[::2]:18900')).toBe(false);
    expect(isHostAllowed('[fe80::1]:18900')).toBe(false);
  });
});
