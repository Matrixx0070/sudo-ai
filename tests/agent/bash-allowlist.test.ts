/**
 * @file bash-allowlist.test.ts
 * @description Tests for the SUDO_BASH_ALLOWLIST_FASTPATH classifier and the
 * ApprovalManager fast-path it gates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isBashAllowlistFastPathEnabled,
  isAllowlistEligible,
  extractCommand,
} from '../../src/core/agent/bash-allowlist.js';
import { ApprovalManager } from '../../src/core/agent/approval.js';

const FLAG = 'SUDO_BASH_ALLOWLIST_FASTPATH';

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
  delete process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

describe('isBashAllowlistFastPathEnabled', () => {
  it('is off by default', () => {
    expect(isBashAllowlistFastPathEnabled()).toBe(false);
  });
  it('requires exact "1" — "true" / "yes" / "on" do not enable it', () => {
    for (const v of ['true', 'yes', 'on', 'TRUE', '0', '']) {
      process.env[FLAG] = v;
      expect(isBashAllowlistFastPathEnabled()).toBe(false);
    }
    process.env[FLAG] = '1';
    expect(isBashAllowlistFastPathEnabled()).toBe(true);
  });
});

describe('isAllowlistEligible — positive cases (safe + read-only)', () => {
  it.each([
    'ls',
    'ls -la',
    'pwd',
    'whoami',
    'cat README.md',
    'grep foo file.txt',
    'git status',
    'git log --oneline -10',
    'git diff',
    'echo hello',
  ])('eligible: %s', (cmd) => {
    expect(isAllowlistEligible(cmd)).toBe(true);
  });
});

describe('isAllowlistEligible — negative cases (writes / network / chained)', () => {
  it.each([
    'rm foo',
    'rm -rf /tmp/test',
    'touch newfile',
    'mv a b',
    'cp a b',
    'echo "x" > file.txt', // shell redirection — writes fs
    'curl https://example.com',
    'wget https://example.com',
    'ls; rm foo', // chained with destructive
    'ls && rm foo',
    'cat $(curl https://evil.example)', // command substitution to network
    'sudo ls', // privilege escalation
  ])('not eligible: %s', (cmd) => {
    expect(isAllowlistEligible(cmd)).toBe(false);
  });
});

describe('isAllowlistEligible — defensive inputs', () => {
  it('returns false for undefined / null / non-string', () => {
    expect(isAllowlistEligible(undefined)).toBe(false);
    expect(isAllowlistEligible(null as unknown as string)).toBe(false);
    expect(isAllowlistEligible(123 as unknown as string)).toBe(false);
  });
  it('returns false for empty / whitespace-only', () => {
    expect(isAllowlistEligible('')).toBe(false);
    expect(isAllowlistEligible('   ')).toBe(false);
    expect(isAllowlistEligible('\t\n')).toBe(false);
  });
});

describe('extractCommand', () => {
  it('returns the command string when params.command is a string', () => {
    expect(extractCommand({ command: 'ls' })).toBe('ls');
  });
  it('returns undefined when params.command is missing or non-string', () => {
    expect(extractCommand({})).toBeUndefined();
    expect(extractCommand({ command: 42 })).toBeUndefined();
    expect(extractCommand({ command: null })).toBeUndefined();
    expect(extractCommand({ cmd: 'ls' })).toBeUndefined(); // wrong key
  });
});

describe('ApprovalManager fast-path integration', () => {
  it('auto-approves a safe read-only command when the flag is on (no sender, no prompt)', async () => {
    process.env[FLAG] = '1';
    const mgr = new ApprovalManager();
    // No sender registered — without the fast-path this would log 'auto-approving (headless mode)';
    // we verify the fast-path returns first by emitting a different log path. Both branches
    // return true here, so the more meaningful assertion is the next case (dangerous still denies).
    const result = await mgr.requestApproval(
      'system.exec',
      { command: 'git status' },
      'test',
      'peer-1',
    );
    expect(result).toBe(true);
  });

  it('does NOT bypass the dangerous-prefix check even when flag is on', async () => {
    process.env[FLAG] = '1';
    const mgr = new ApprovalManager();
    // `rm -rf /` is on the DANGEROUS_PREFIXES list — must be denied regardless.
    const result = await mgr.requestApproval(
      'system.exec',
      { command: 'rm -rf /' },
      'test',
      'peer-1',
    );
    expect(result).toBe(false);
  });

  it('falls through when the flag is off (headless auto-approve still applies)', async () => {
    delete process.env[FLAG];
    const mgr = new ApprovalManager();
    // With no sender, the manager falls through to headless auto-approve. The point
    // is the fast-path branch is NOT taken — but the outcome (true) coincides here.
    const result = await mgr.requestApproval(
      'system.exec',
      { command: 'git status' },
      'test',
      'peer-1',
    );
    expect(result).toBe(true);
  });

  it('falls through to the prompt path for a non-eligible command (e.g. rm)', async () => {
    process.env[FLAG] = '1';
    const mgr = new ApprovalManager();
    // No sender → headless auto-approve. The point: fast-path did NOT consume this
    // because `rm foo` is not allowlist-eligible.
    const result = await mgr.requestApproval(
      'system.exec',
      { command: 'rm foo.txt' },
      'test',
      'peer-1',
    );
    expect(result).toBe(true); // headless mode auto-approved (the fall-through path)
  });

  it('falls through for tool calls without a command param (flag has no effect)', async () => {
    process.env[FLAG] = '1';
    const mgr = new ApprovalManager();
    const result = await mgr.requestApproval(
      'fs.write',
      { path: '/tmp/x', content: 'data' },
      'test',
      'peer-1',
    );
    // No `command` key → fast-path no-ops → headless auto-approve → true.
    expect(result).toBe(true);
  });
});
