/**
 * @file tests/sandbox/sandbox-args-env.test.ts
 * @description Unit tests for buildBwrapArgs, buildSandboxEnv, and policy helpers.
 * Tests 1-13 from spec §7 Builder A list.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildBwrapArgs, buildSandboxEnv } from '../../src/core/sandbox/sandbox-runner.js';
import { mergePolicy, parsePolicy, validateBindPath } from '../../src/core/sandbox/sandbox-policy.js';
import {
  DEFAULT_SANDBOX_POLICY,
  ENV_ALLOWLIST_BASE,
  SandboxPolicyError,
  type SandboxPolicy,
} from '../../src/core/sandbox/sandbox-types.js';

// ---------------------------------------------------------------------------
// buildBwrapArgs tests (1-5)
// ---------------------------------------------------------------------------

describe('buildBwrapArgs', () => {
  const workspaceDir = '/tmp/test-workspace/session-abc';

  it('test 1: includes --unshare-net when network=none', () => {
    const policy: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, network: 'none' };
    const args = buildBwrapArgs('echo hi', workspaceDir, policy);
    expect(args).toContain('--unshare-net');
  });

  it('test 2: omits --unshare-net when network=host', () => {
    const policy: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, network: 'host' };
    const args = buildBwrapArgs('echo hi', workspaceDir, policy);
    expect(args).not.toContain('--unshare-net');
  });

  it('test 3: includes extraReadOnlyBinds', () => {
    const policy: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      extraReadOnlyBinds: ['/opt/python', '/usr/local/lib'],
    };
    // FIX #4: pass identity realpathSync so the test doesn't require the paths to exist on disk
    const args = buildBwrapArgs('python3 --version', workspaceDir, policy, undefined, (p) => p);
    expect(args).toContain('--ro-bind');
    // Find pairs: --ro-bind /opt/python /opt/python
    const idx = args.indexOf('/opt/python');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx - 1]).toBe('--ro-bind');
    expect(args[idx + 1]).toBe('/opt/python');
  });

  it('test 4: includes extraWritableBinds', () => {
    const policy: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      extraWritableBinds: ['/mnt/shared'],
    };
    // FIX #4: pass identity realpathSync so the test doesn't require the path to exist on disk
    const args = buildBwrapArgs('ls /mnt/shared', workspaceDir, policy, undefined, (p) => p);
    // --bind /mnt/shared /mnt/shared
    const idx = args.indexOf('/mnt/shared');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx - 1]).toBe('--bind');
    expect(args[idx + 1]).toBe('/mnt/shared');
  });

  it('test 5: lib64 bind is conditional on existsSync', () => {
    // Use the injected _existsSync parameter for unit-testable control.
    const argsWithLib64 = buildBwrapArgs(
      'echo',
      workspaceDir,
      DEFAULT_SANDBOX_POLICY,
      (_p) => true, // simulate: /lib64 exists
    );
    expect(argsWithLib64).toContain('/lib64');

    const argsWithoutLib64 = buildBwrapArgs(
      'echo',
      workspaceDir,
      DEFAULT_SANDBOX_POLICY,
      (_p) => false, // simulate: /lib64 absent
    );
    expect(argsWithoutLib64).not.toContain('/lib64');
  });

  it('includes --die-with-parent and required isolation flags', () => {
    const args = buildBwrapArgs('echo hi', workspaceDir, DEFAULT_SANDBOX_POLICY);
    expect(args).toContain('--die-with-parent');
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--unshare-ipc');
    expect(args).toContain('--unshare-uts');
    expect(args).toContain('--new-session');
  });

  it('embeds ulimit with correct values in the shell command', () => {
    const policy: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      cpuSeconds: 45,
      maxFileMB: 200,
      memoryMB: 1024,
    };
    const args = buildBwrapArgs('my-cmd', workspaceDir, policy);
    const shellCmd = args[args.length - 1];
    expect(shellCmd).toContain('ulimit -SHt 45');
    expect(shellCmd).toContain(`ulimit -SHf ${200 * 2048}`);
    expect(shellCmd).toContain(`ulimit -SHv ${1024 * 1024}`);
    expect(shellCmd).toContain('ulimit -SHu 64');
    expect(shellCmd).toContain('my-cmd');
  });
});

// ---------------------------------------------------------------------------
// buildSandboxEnv tests (6-9)
// ---------------------------------------------------------------------------

describe('buildSandboxEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Inject test values into process.env
    process.env['ANTHROPIC_API_KEY'] = 'sk-secret-should-not-leak';
    process.env['PATH'] = '/usr/bin:/bin';
    process.env['LANG'] = 'en_US.UTF-8';
    process.env['LC_ALL'] = 'C';
    process.env['TERM'] = 'xterm-256color';
  });

  afterEach(() => {
    // Clean up injected keys
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('test 6: ANTHROPIC_API_KEY is NOT present in sandbox env', () => {
    const env = buildSandboxEnv(DEFAULT_SANDBOX_POLICY);
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('test 7: HOME is always /workspace', () => {
    const env = buildSandboxEnv(DEFAULT_SANDBOX_POLICY);
    expect(env['HOME']).toBe('/workspace');
  });

  it('test 8: USER is always sandbox', () => {
    const env = buildSandboxEnv(DEFAULT_SANDBOX_POLICY);
    expect(env['USER']).toBe('sandbox');
  });

  it('test 9: allowedEnvVars are appended to base allowlist', () => {
    process.env['MY_CUSTOM_VAR'] = 'custom-value';
    const policy: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      allowedEnvVars: ['MY_CUSTOM_VAR'],
    };
    const env = buildSandboxEnv(policy);
    expect(env['MY_CUSTOM_VAR']).toBe('custom-value');
    delete process.env['MY_CUSTOM_VAR'];
  });

  it('only passes through ENV_ALLOWLIST_BASE keys that exist in process.env', () => {
    const env = buildSandboxEnv(DEFAULT_SANDBOX_POLICY);
    const keys = Object.keys(env);
    // All keys must be from allowlist, HOME, or USER
    const allowedSet = new Set([...ENV_ALLOWLIST_BASE, 'HOME', 'USER']);
    for (const key of keys) {
      expect(allowedSet.has(key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// mergePolicy + parsePolicy tests (26-28)
// ---------------------------------------------------------------------------

describe('mergePolicy', () => {
  it('test 26: override fields win over base', () => {
    const base: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, network: 'none', cpuSeconds: 30 };
    const override: Partial<SandboxPolicy> = { network: 'host', cpuSeconds: 60 };
    const result = mergePolicy(base, override);
    expect(result.network).toBe('host');
    expect(result.cpuSeconds).toBe(60);
    // Non-overridden fields kept from base
    expect(result.enabled).toBe(base.enabled);
  });

  it('test 27: unknown / extra fields in raw are dropped by parsePolicy', () => {
    const raw = {
      enabled: true,
      network: 'none',
      cpuSeconds: 10,
      someBogusField: 'should be dropped',
      anotherBogus: 123,
    };
    const policy = parsePolicy(raw);
    expect((policy as unknown as Record<string, unknown>)['someBogusField']).toBeUndefined();
    expect((policy as unknown as Record<string, unknown>)['anotherBogus']).toBeUndefined();
    expect(policy.cpuSeconds).toBe(10);
  });

  it('test 28: enabled=false is respected after merge', () => {
    const base: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, enabled: true };
    const override: Partial<SandboxPolicy> = { enabled: false };
    const result = mergePolicy(base, override);
    expect(result.enabled).toBe(false);
  });

  it('mergePolicy: arrays are replaced not concatenated', () => {
    const base: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      extraReadOnlyBinds: ['/a'],
    };
    const override: Partial<SandboxPolicy> = { extraReadOnlyBinds: ['/b', '/c'] };
    const result = mergePolicy(base, override);
    expect(result.extraReadOnlyBinds).toEqual(['/b', '/c']);
  });
});

describe('parsePolicy', () => {
  it('returns default policy for null input', () => {
    const policy = parsePolicy(null);
    expect(policy.enabled).toBe(DEFAULT_SANDBOX_POLICY.enabled);
    expect(policy.network).toBe(DEFAULT_SANDBOX_POLICY.network);
  });

  it('returns default policy for non-object input', () => {
    const policy = parsePolicy('invalid-string');
    expect(policy.enabled).toBe(DEFAULT_SANDBOX_POLICY.enabled);
  });

  it('parses valid policy object correctly', () => {
    const raw = {
      enabled: false,
      network: 'host',
      cpuSeconds: 60,
      memoryMB: 256,
      maxFileMB: 50,
      extraReadOnlyBinds: ['/opt/tools'],
      allowedEnvVars: ['CUSTOM_VAR'],
    };
    const policy = parsePolicy(raw);
    expect(policy.enabled).toBe(false);
    expect(policy.network).toBe('host');
    expect(policy.cpuSeconds).toBe(60);
    expect(policy.memoryMB).toBe(256);
    expect(policy.extraReadOnlyBinds).toEqual(['/opt/tools']);
    expect(policy.allowedEnvVars).toEqual(['CUSTOM_VAR']);
  });

  it('rejects invalid network value and falls back to default', () => {
    const policy = parsePolicy({ network: 'vpn' });
    expect(policy.network).toBe(DEFAULT_SANDBOX_POLICY.network);
  });
});

// ---------------------------------------------------------------------------
// Security fix tests — Wave 5 P3 (fixes 1-3, 6)
// ---------------------------------------------------------------------------

describe('fix 1: ulimit hard+soft — sandbox cannot raise limits', () => {
  it('ulimit -SH flags are set in shell command string', () => {
    const args = buildBwrapArgs('echo ok', '/tmp/ws', DEFAULT_SANDBOX_POLICY);
    const shellCmd = args[args.length - 1];
    // Hard+soft CPU limit
    expect(shellCmd).toMatch(/ulimit -SHt \d+/);
    // Hard+soft memory limit
    expect(shellCmd).toMatch(/ulimit -SHv \d+/);
  });
});

describe('fix 2: bind path validation', () => {
  it('extraWritableBinds: ["/"] is rejected by buildBwrapArgs', () => {
    const policy: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, extraWritableBinds: ['/'] };
    // identity realpathSync: path itself; '/' is still rejected by validateBindPath
    expect(() => buildBwrapArgs('echo', '/tmp/ws', policy, undefined, (p) => p)).toThrow(SandboxPolicyError);
  });

  it('extraReadOnlyBinds: ["/etc/shadow"] is rejected by buildBwrapArgs', () => {
    const policy: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, extraReadOnlyBinds: ['/etc/shadow'] };
    // identity realpathSync: /etc/shadow resolves to itself; rejected by /etc prefix in denylist
    expect(() => buildBwrapArgs('echo', '/tmp/ws', policy, undefined, (p) => p)).toThrow(SandboxPolicyError);
  });

  it('extraReadOnlyBinds: ["../../../etc"] is rejected by buildBwrapArgs', () => {
    const policy: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, extraReadOnlyBinds: ['../../../etc'] };
    // identity realpathSync: path itself; validateBindPath rejects non-absolute paths
    expect(() => buildBwrapArgs('echo', '/tmp/ws', policy, undefined, (p) => p)).toThrow(SandboxPolicyError);
  });
});

describe('fix 3: secret env denylist in buildSandboxEnv', () => {
  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-should-not-leak';
    process.env['FOO_SECRET'] = 'super-secret';
    process.env['MY_SAFE_VAR'] = 'safe-value';
  });

  afterEach(() => {
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['FOO_SECRET'];
    delete process.env['MY_SAFE_VAR'];
  });

  it('ANTHROPIC_API_KEY requested via allowedEnvVars is NOT in sandbox env', () => {
    const policy: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      allowedEnvVars: ['ANTHROPIC_API_KEY'],
    };
    const env = buildSandboxEnv(policy);
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('FOO_SECRET requested via allowedEnvVars is NOT in sandbox env', () => {
    const policy: SandboxPolicy = {
      ...DEFAULT_SANDBOX_POLICY,
      allowedEnvVars: ['FOO_SECRET'],
    };
    const env = buildSandboxEnv(policy);
    expect(env['FOO_SECRET']).toBeUndefined();
  });
});

describe('fix 6: bind array length cap at 32', () => {
  it('100-entry extraReadOnlyBinds array is capped to 32 entries by parsePolicy', () => {
    const entries = Array.from({ length: 100 }, (_, i) => `/opt/tool-${i}`);
    const policy = parsePolicy({ extraReadOnlyBinds: entries });
    expect((policy.extraReadOnlyBinds ?? []).length).toBeLessThanOrEqual(32);
  });
});
