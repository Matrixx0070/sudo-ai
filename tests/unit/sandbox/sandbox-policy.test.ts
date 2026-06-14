/**
 * @file tests/unit/sandbox/sandbox-policy.test.ts
 * @description Unit tests for security-debt-sweep Items 1 and 2.
 *
 * Item 1: parseBindArray normalizes paths to canonical form before storing.
 * Item 2: mergePolicy validates + normalizes override bind paths, filters
 *         denylist entries, and applies the 32-entry cap AFTER filtering so
 *         attacker-padded denylist entries cannot push valid paths out.
 */

import { describe, it, expect } from 'vitest';
import { validateBindPath, mergePolicy, parsePolicy } from '../../../src/core/sandbox/sandbox-policy.js';
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from '../../../src/core/sandbox/sandbox-types.js';

// ---------------------------------------------------------------------------
// ITEM 1 — parseBindArray normalization via parsePolicy
// We test normalization indirectly through parsePolicy which calls parseBindArray.
// ---------------------------------------------------------------------------

describe('ITEM 1: parseBindArray stores canonical (normalized) paths', () => {
  it('normalizes /tmp/./work to /tmp/work', () => {
    const policy = parsePolicy({ extraReadOnlyBinds: ['/tmp/./work'] });
    expect(policy.extraReadOnlyBinds).toEqual(['/tmp/work']);
  });

  it('normalizes /tmp/work/ (trailing slash) to /tmp/work', () => {
    const policy = parsePolicy({ extraReadOnlyBinds: ['/tmp/work/'] });
    expect(policy.extraReadOnlyBinds).toEqual(['/tmp/work']);
  });

  it('normalizes /tmp//work (double slash) to /tmp/work', () => {
    const policy = parsePolicy({ extraReadOnlyBinds: ['/tmp//work'] });
    expect(policy.extraReadOnlyBinds).toEqual(['/tmp/work']);
  });

  it('normalizes /opt/data///subdir/ to /opt/data/subdir', () => {
    const policy = parsePolicy({ extraReadOnlyBinds: ['/opt/data///subdir/'] });
    expect(policy.extraReadOnlyBinds).toEqual(['/opt/data/subdir']);
  });

  it('normalizes extraWritableBinds the same way', () => {
    const policy = parsePolicy({ extraWritableBinds: ['/tmp/./workspace/', '/tmp//tools'] });
    expect(policy.extraWritableBinds).toEqual(['/tmp/workspace', '/tmp/tools']);
  });

  it('drops denylist paths and does not include them in the result', () => {
    const policy = parsePolicy({
      extraReadOnlyBinds: ['/etc/passwd', '/tmp/work', '/root/.ssh/id_rsa', '/proc/self'],
    });
    expect(policy.extraReadOnlyBinds).toEqual(['/tmp/work']);
  });

  it('drops /etc/../tmp/work (resolves to /tmp/work — ALLOWED)', () => {
    // path.posix.normalize('/etc/../tmp/work') === '/tmp/work'
    // This is ALLOWED per documented behavior in validateBindPath
    const policy = parsePolicy({ extraReadOnlyBinds: ['/etc/../tmp/work'] });
    expect(policy.extraReadOnlyBinds).toEqual(['/tmp/work']);
  });

  it('drops //etc/passwd (normalizes to /etc/passwd — DENIED)', () => {
    const policy = parsePolicy({ extraReadOnlyBinds: ['//etc/passwd', '/tmp/work'] });
    expect(policy.extraReadOnlyBinds).toEqual(['/tmp/work']);
  });

  it('returns undefined when all paths are denylist-rejected', () => {
    const policy = parsePolicy({ extraReadOnlyBinds: ['/etc/passwd', '/root/.ssh/id_rsa'] });
    expect(policy.extraReadOnlyBinds).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ITEM 2 — mergePolicy filters + normalizes override bind paths
// ---------------------------------------------------------------------------

describe('ITEM 2: mergePolicy filters denylist paths from override binds', () => {
  const base = { ...DEFAULT_SANDBOX_POLICY };

  it('drops /etc/passwd from override.extraReadOnlyBinds, keeps /tmp/work', () => {
    const result = mergePolicy(base, {
      extraReadOnlyBinds: ['/etc/passwd', '/tmp/work'],
    });
    expect(result.extraReadOnlyBinds).toEqual(['/tmp/work']);
  });

  it('drops /root/.ssh from override.extraWritableBinds, keeps /tmp/sandbox', () => {
    const result = mergePolicy(base, {
      extraWritableBinds: ['/root/.ssh', '/tmp/sandbox'],
    });
    expect(result.extraWritableBinds).toEqual(['/tmp/sandbox']);
  });

  it('normalizes /tmp/./work/ in override.extraReadOnlyBinds to /tmp/work', () => {
    const result = mergePolicy(base, {
      extraReadOnlyBinds: ['/tmp/./work/'],
    });
    expect(result.extraReadOnlyBinds).toEqual(['/tmp/work']);
  });

  it('normalizes /tmp//sandbox in override.extraWritableBinds to /tmp/sandbox', () => {
    const result = mergePolicy(base, {
      extraWritableBinds: ['/tmp//sandbox/'],
    });
    expect(result.extraWritableBinds).toEqual(['/tmp/sandbox']);
  });

  it('keeps base binds unchanged when override has none', () => {
    const baseWithBinds: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      extraReadOnlyBinds: ['/opt/python'],
      extraWritableBinds: ['/tmp/workdir'],
    };
    const result = mergePolicy(baseWithBinds, { enabled: false });
    expect(result.extraReadOnlyBinds).toEqual(['/opt/python']);
    expect(result.extraWritableBinds).toEqual(['/tmp/workdir']);
  });

  it('returns undefined for extraReadOnlyBinds when all override entries are denylist-rejected', () => {
    const result = mergePolicy(base, {
      extraReadOnlyBinds: ['/etc/passwd', '/sys/kernel', '/proc/1'],
    });
    // All filtered out — should be empty array (not undefined) because override was defined
    // but all entries were filtered. Empty array from .filter().map().slice() is truthy — check behavior.
    expect(result.extraReadOnlyBinds).toEqual([]);
  });

  it('empty override array returns empty array (override was explicitly set)', () => {
    const baseWithBinds: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      extraReadOnlyBinds: ['/opt/python'],
    };
    const result = mergePolicy(baseWithBinds, { extraReadOnlyBinds: [] });
    // explicit empty override replaces base binds
    expect(result.extraReadOnlyBinds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ITEM 2 — 32-cap applied AFTER filtering (security ordering invariant)
// An attacker padding 32 denylist entries CANNOT push valid paths out of window.
// ---------------------------------------------------------------------------

describe('ITEM 2: 32-entry cap is applied AFTER denylist filtering', () => {
  it('32 denylist entries followed by 1 valid entry: valid entry survives', () => {
    // Build 32 invalid (denylist) entries
    const deniedEntries = Array.from({ length: 32 }, (_, i) => `/etc/denied-path-${i}`);
    const validEntry = '/tmp/legit-workdir';

    const result = mergePolicy(
      { ...DEFAULT_SANDBOX_POLICY },
      { extraReadOnlyBinds: [...deniedEntries, validEntry] },
    );

    // Under old code (slice BEFORE filter), valid entry would be at index 32, sliced off.
    // Under fixed code (filter BEFORE slice), all 32 denylist entries drop, valid survives.
    expect(result.extraReadOnlyBinds).toContain(validEntry);
  });

  it('33 valid entries: slice to 32 after filtering keeps first 32 valid ones', () => {
    const validEntries = Array.from({ length: 33 }, (_, i) => `/tmp/workdir-${i}`);
    const result = mergePolicy(
      { ...DEFAULT_SANDBOX_POLICY },
      { extraReadOnlyBinds: validEntries },
    );
    expect(result.extraReadOnlyBinds).toHaveLength(32);
    // Should be the first 32 valid entries
    expect(result.extraReadOnlyBinds![0]).toBe('/tmp/workdir-0');
    expect(result.extraReadOnlyBinds![31]).toBe('/tmp/workdir-31');
  });

  it('same padding-attack test for extraWritableBinds', () => {
    const deniedEntries = Array.from({ length: 32 }, (_, i) => `/root/padding-${i}`);
    const validEntry = '/tmp/writable-workdir';

    const result = mergePolicy(
      { ...DEFAULT_SANDBOX_POLICY },
      { extraWritableBinds: [...deniedEntries, validEntry] },
    );

    expect(result.extraWritableBinds).toContain(validEntry);
  });
});

// ---------------------------------------------------------------------------
// NUL-byte defense (security-debt-sweep follow-up)
// ---------------------------------------------------------------------------

describe('NUL-byte defense: validateBindPath rejects paths containing \\x00', () => {
  it('/tmp\\x00/evil returns false', () => {
    expect(validateBindPath('/tmp\x00/evil')).toBe(false);
  });

  it('\\x00tmp returns false', () => {
    expect(validateBindPath('\x00tmp')).toBe(false);
  });

  it('/proc\\x00/safe returns false (NUL truncation would leave /proc)', () => {
    expect(validateBindPath('/proc\x00/safe')).toBe(false);
  });

  it('/opt/work\\x00 returns false', () => {
    expect(validateBindPath('/opt/work\x00')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: existing validateBindPath behavior preserved
// ---------------------------------------------------------------------------

describe('Regression: existing validateBindPath behavior preserved', () => {
  it('/proc is denied', () => expect(validateBindPath('/proc')).toBe(false));
  it('/sys is denied', () => expect(validateBindPath('/sys')).toBe(false));
  it('/etc is denied', () => expect(validateBindPath('/etc')).toBe(false));
  it('/root is denied', () => expect(validateBindPath('/root')).toBe(false));
  it('/dev is denied', () => expect(validateBindPath('/dev')).toBe(false));
  it('/dev/shm is denied', () => expect(validateBindPath('/dev/shm')).toBe(false));
  it('/dev/null is denied (/dev prefix)', () => expect(validateBindPath('/dev/null')).toBe(false));
  it('/var/run is denied', () => expect(validateBindPath('/var/run')).toBe(false));
  it('/var/log is denied', () => expect(validateBindPath('/var/log')).toBe(false));
  it('/tmp is allowed', () => expect(validateBindPath('/tmp')).toBe(true));
  it('/opt/myapp is allowed', () => expect(validateBindPath('/opt/myapp')).toBe(true));
  it('/ (root) is denied', () => expect(validateBindPath('/')).toBe(false));
  it('relative path is denied', () => expect(validateBindPath('tmp/work')).toBe(false));
  it('// normalizes to / — denied', () => expect(validateBindPath('//')).toBe(false));
  it('//etc/passwd normalizes to /etc/passwd — denied', () => expect(validateBindPath('//etc/passwd')).toBe(false));
});

describe('gap #27: per-policy execBackend', () => {
  it('parsePolicy accepts a valid backend token (normalized to lowercase)', () => {
    expect(parsePolicy({ execBackend: 'docker' }).execBackend).toBe('docker');
    expect(parsePolicy({ execBackend: '  Docker ' }).execBackend).toBe('docker');
    expect(parsePolicy({ execBackend: 'my-backend_2' }).execBackend).toBe('my-backend_2');
  });

  it('parsePolicy drops a malformed / non-string execBackend (falls back to env/local)', () => {
    expect(parsePolicy({ execBackend: 'bad name!' }).execBackend).toBeUndefined();
    expect(parsePolicy({ execBackend: 'a;b' }).execBackend).toBeUndefined();
    expect(parsePolicy({ execBackend: 123 }).execBackend).toBeUndefined();
    expect(parsePolicy({ execBackend: '' }).execBackend).toBeUndefined();
    expect(parsePolicy({}).execBackend).toBeUndefined();
  });

  it('mergePolicy carries execBackend through (override wins, else base) — no silent drop', () => {
    const base: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, execBackend: 'docker' };
    // base value survives when the override does not set it
    expect(mergePolicy(base, {}).execBackend).toBe('docker');
    // override wins
    expect(mergePolicy(base, { execBackend: 'ssh' }).execBackend).toBe('ssh');
  });
});
