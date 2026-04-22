/**
 * @file tests/sandbox/sandbox-security-r2.test.ts
 * @description Security-fix tests for Wave 5 P3 R2 rejection blockers.
 * Covers FIX #1 (double-slash bypass), FIX #2 (Infinity bypass in parsePolicy),
 * FIX #3 (/dev not in denylist), and FIX #4 (symlink bypass on extraBind paths).
 *
 * Total new tests: 15 (≥ 10 required by acceptance criteria).
 */

import { describe, it, expect } from 'vitest';
import { validateBindPath, parsePolicy, mergePolicy } from '../../src/core/sandbox/sandbox-policy.js';
import { buildBwrapArgs } from '../../src/core/sandbox/sandbox-runner.js';
import {
  DEFAULT_SANDBOX_POLICY,
  SandboxPolicyError,
  type SandboxPolicy,
} from '../../src/core/sandbox/sandbox-types.js';

// ---------------------------------------------------------------------------
// FIX #1 — Double-slash bypass in validateBindPath (4 tests)
// ---------------------------------------------------------------------------

describe('FIX #1: double-slash normalization in validateBindPath', () => {
  it('//etc/passwd normalizes to /etc/passwd → false (denied by /etc prefix)', () => {
    expect(validateBindPath('//etc/passwd')).toBe(false);
  });

  it('//root normalizes to /root → false (denied by /root prefix)', () => {
    expect(validateBindPath('//root')).toBe(false);
  });

  it('//etc/ normalizes to /etc → false (denied by /etc prefix)', () => {
    expect(validateBindPath('//etc/')).toBe(false);
  });

  it('/etc/../tmp normalizes to /tmp → true (allowed path — documented behavior)', () => {
    // path.posix.normalize('/etc/../tmp') === '/tmp'
    // /tmp is not in BIND_DENYLIST_PREFIXES so it is allowed.
    // The realpathSync check in buildBwrapArgs provides defense-in-depth.
    expect(validateBindPath('/etc/../tmp')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIX #2 — Infinity / NaN / out-of-range bypass in parsePolicy (5 tests)
// ---------------------------------------------------------------------------

describe('FIX #2: Infinity/NaN/out-of-range numeric values fall back to defaults in parsePolicy', () => {
  it('parsePolicy({cpuSeconds: Infinity}) → DEFAULT_SANDBOX_POLICY.cpuSeconds', () => {
    const policy = parsePolicy({ cpuSeconds: Infinity });
    expect(policy.cpuSeconds).toBe(DEFAULT_SANDBOX_POLICY.cpuSeconds);
  });

  it('parsePolicy({cpuSeconds: NaN}) → DEFAULT_SANDBOX_POLICY.cpuSeconds', () => {
    const policy = parsePolicy({ cpuSeconds: NaN });
    expect(policy.cpuSeconds).toBe(DEFAULT_SANDBOX_POLICY.cpuSeconds);
  });

  it('parsePolicy({cpuSeconds: 99999}) → default (above 3600 cap)', () => {
    const policy = parsePolicy({ cpuSeconds: 99999 });
    expect(policy.cpuSeconds).toBe(DEFAULT_SANDBOX_POLICY.cpuSeconds);
  });

  it('parsePolicy({memoryMB: Infinity}) → DEFAULT_SANDBOX_POLICY.memoryMB', () => {
    const policy = parsePolicy({ memoryMB: Infinity });
    expect(policy.memoryMB).toBe(DEFAULT_SANDBOX_POLICY.memoryMB);
  });

  it('parsePolicy({maxFileMB: Infinity}) → DEFAULT_SANDBOX_POLICY.maxFileMB', () => {
    const policy = parsePolicy({ maxFileMB: Infinity });
    expect(policy.maxFileMB).toBe(DEFAULT_SANDBOX_POLICY.maxFileMB);
  });
});

// ---------------------------------------------------------------------------
// FIX #3 — /dev not in BIND_DENYLIST_PREFIXES (4 tests)
// ---------------------------------------------------------------------------

describe('FIX #3: /dev and sub-paths are denied by validateBindPath', () => {
  it('/dev is denied', () => {
    expect(validateBindPath('/dev')).toBe(false);
  });

  it('/dev/mem is denied (raw memory device)', () => {
    expect(validateBindPath('/dev/mem')).toBe(false);
  });

  it('/dev/sda is denied (raw block device)', () => {
    expect(validateBindPath('/dev/sda')).toBe(false);
  });

  it('/dev/kmem is denied (kernel memory device)', () => {
    expect(validateBindPath('/dev/kmem')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX #4 — Symlink bypass on extraBind paths in buildBwrapArgs (4 tests)
// ---------------------------------------------------------------------------

describe('FIX #4: symlink bypass is blocked in buildBwrapArgs via realpathSync', () => {
  it('symlink that resolves to /etc/shadow → SandboxPolicyError (denied path after realpath)', () => {
    const policy: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      extraReadOnlyBinds: ['/tmp/evil-symlink'],
    };
    // Simulate: realpath('/tmp/evil-symlink') === '/etc/shadow' — denied by /etc prefix
    const fakeRealpath = (_p: string): string => '/etc/shadow';
    expect(() =>
      buildBwrapArgs('echo', '/tmp/ws', policy, undefined, fakeRealpath),
    ).toThrow(SandboxPolicyError);
  });

  it('symlink that resolves to /dev/mem → SandboxPolicyError (denied path after realpath)', () => {
    const policy: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      extraWritableBinds: ['/tmp/dev-link'],
    };
    // Simulate: realpath('/tmp/dev-link') === '/dev/mem' — denied by /dev prefix
    const fakeRealpath = (_p: string): string => '/dev/mem';
    expect(() =>
      buildBwrapArgs('echo', '/tmp/ws', policy, undefined, fakeRealpath),
    ).toThrow(SandboxPolicyError);
  });

  it('non-existent bind path → SandboxPolicyError (realpath throws ENOENT)', () => {
    const policy: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      extraReadOnlyBinds: ['/tmp/does-not-exist-xyz'],
    };
    // Simulate realpathSync throwing as it would for a missing path
    const fakeRealpath = (_p: string): string => {
      throw new Error('ENOENT: no such file or directory');
    };
    expect(() =>
      buildBwrapArgs('echo', '/tmp/ws', policy, undefined, fakeRealpath),
    ).toThrow(SandboxPolicyError);
  });

  it('valid existing path not matching denylist → resolves and succeeds', () => {
    const policy: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      extraReadOnlyBinds: ['/tmp/safe-dir'],
    };
    // Simulate: realpath('/tmp/safe-dir') === '/tmp/safe-dir' — allowed
    const fakeRealpath = (p: string): string => p;
    expect(() =>
      buildBwrapArgs('echo', '/tmp/ws', policy, undefined, fakeRealpath),
    ).not.toThrow();
    const args = buildBwrapArgs('echo', '/tmp/ws', policy, undefined, fakeRealpath);
    // Resolved path is used as both source and target
    const idx = args.indexOf('/tmp/safe-dir');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx - 1]).toBe('--ro-bind');
    expect(args[idx + 1]).toBe('/tmp/safe-dir');
  });
});

// ---------------------------------------------------------------------------
// FIX #2 regression — mergePolicy also respects caps
// ---------------------------------------------------------------------------

describe('FIX #2 regression: mergePolicy rejects Infinity/NaN/out-of-range overrides', () => {
  it('mergePolicy with cpuSeconds: Infinity keeps base value', () => {
    const base: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, cpuSeconds: 30 };
    const result = mergePolicy(base, { cpuSeconds: Infinity });
    expect(result.cpuSeconds).toBe(30);
  });

  it('mergePolicy with memoryMB: NaN keeps base value', () => {
    const base: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, memoryMB: 256 };
    const result = mergePolicy(base, { memoryMB: NaN });
    expect(result.memoryMB).toBe(256);
  });
});
