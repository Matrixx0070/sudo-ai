/**
 * @file tests/sandbox/sandbox-darwin.test.ts
 * @description Cross-platform sandbox dispatch tests:
 *   - Linux keeps the exact bwrap invocation (regression guard for prod).
 *   - darwin hosts route to the Seatbelt (sandbox-exec) runner.
 *   - Seatbelt profile faithfully translates the policy (deny default,
 *     workspace-only writes, network per policy).
 *   - Missing sandbox binaries (ENOENT) produce actionable errors, not
 *     silent empty-output failures.
 *
 * execFile is mocked — no bwrap/sandbox-exec is ever actually spawned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

import {
  BWRAP_BIN,
  SANDBOX_EXEC_BIN,
  buildBwrapArgs,
  buildSeatbeltArgs,
  buildSeatbeltProfile,
  buildUlimitWrappedCommand,
  resolveSandboxPlatform,
  runInSandbox,
} from '../../src/core/sandbox/sandbox-runner.js';
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from '../../src/core/sandbox/sandbox-types.js';

const WS = '/tmp/sandbox-darwin-test-ws';

/** Make the mocked execFile succeed (callback style, promisify-compatible). */
function mockExecSuccess(stdout = 'ok', stderr = ''): void {
  execFileMock.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
      cb(null, { stdout, stderr });
      return {};
    },
  );
}

/** Make the mocked execFile fail with the given error fields. */
function mockExecError(fields: Record<string, unknown>): void {
  execFileMock.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) => {
      cb(Object.assign(new Error(String(fields['message'] ?? 'exec failed')), fields), null);
      return {};
    },
  );
}

/** Temporarily override process.platform; returns a restore fn. */
function stubPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', original);
}

const policy: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY };

beforeEach(() => {
  execFileMock.mockReset();
  delete process.env['SUDO_SANDBOX_DISABLE'];
  delete process.env['SUDO_SANDBOX_ALLOW_UNCONFINED'];
  delete process.env['SUDO_EXEC_BACKEND'];
});

afterEach(() => {
  delete process.env['SUDO_SANDBOX_DISABLE'];
  delete process.env['SUDO_SANDBOX_ALLOW_UNCONFINED'];
  delete process.env['SUDO_EXEC_BACKEND'];
});

// ---------------------------------------------------------------------------
// resolveSandboxPlatform
// ---------------------------------------------------------------------------

describe('resolveSandboxPlatform', () => {
  it('linux host + no explicit platform → linux (prod default, unchanged)', () => {
    expect(resolveSandboxPlatform(undefined, undefined, 'linux')).toBe('linux');
  });

  it('darwin host + no explicit platform → mac', () => {
    expect(resolveSandboxPlatform(undefined, undefined, 'darwin')).toBe('mac');
  });

  it('win32 host → win', () => {
    expect(resolveSandboxPlatform(undefined, undefined, 'win32')).toBe('win');
  });

  it('explicit option wins over policy and host', () => {
    expect(resolveSandboxPlatform('mac', 'linux', 'linux')).toBe('mac');
  });

  it('policy.platform wins over host detection', () => {
    expect(resolveSandboxPlatform(undefined, 'win', 'linux')).toBe('win');
  });

  it("'auto' falls through to host detection (fail-safe: linux host → bwrap)", () => {
    expect(resolveSandboxPlatform('auto', 'auto', 'linux')).toBe('linux');
    expect(resolveSandboxPlatform('auto', undefined, 'darwin')).toBe('mac');
  });
});

// ---------------------------------------------------------------------------
// Linux regression guard: bwrap invocation is byte-for-byte what it was
// ---------------------------------------------------------------------------

describe('runInSandbox on linux (regression guard)', () => {
  it('invokes /usr/bin/bwrap with exactly buildBwrapArgs output', async () => {
    const restore = stubPlatform('linux');
    try {
      mockExecSuccess('hello\n');
      const result = await runInSandbox({
        command: 'echo hello',
        workspaceDir: WS,
        policy,
        timeoutMs: 5000,
      });
      expect(result).toEqual({ stdout: 'hello\n', stderr: '', exitCode: 0 });
      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [bin, args] = execFileMock.mock.calls[0] as [string, string[]];
      expect(bin).toBe(BWRAP_BIN);
      expect(args).toEqual(buildBwrapArgs('echo hello', WS, policy));
      // Spot-check the security-critical args are still present
      expect(args).toContain('--unshare-net');
      expect(args).toContain('--unshare-pid');
      expect(args).toContain('--die-with-parent');
      const joined = args.join(' ');
      expect(joined).toContain(`--bind ${WS} /workspace`);
      // Linux ulimit wrapper still includes the virtual-memory cap
      expect(args[args.length - 1]).toContain('ulimit -SHv');
    } finally {
      restore();
    }
  });

  it('bwrap ENOENT produces an actionable exit-127 error, not empty output', async () => {
    const restore = stubPlatform('linux');
    try {
      mockExecError({ code: 'ENOENT', message: 'spawn /usr/bin/bwrap ENOENT' });
      const result = await runInSandbox({
        command: 'echo hi',
        workspaceDir: WS,
        policy,
        timeoutMs: 5000,
      });
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('bwrap not found');
      expect(result.stderr).toContain('SUDO_SANDBOX_DISABLE=1');
    } finally {
      restore();
    }
  });

  it('nonzero child exit codes still pass through unchanged', async () => {
    const restore = stubPlatform('linux');
    try {
      mockExecError({ code: 7, stdout: 'partial', stderr: 'boom' });
      const result = await runInSandbox({
        command: 'exit 7',
        workspaceDir: WS,
        policy,
        timeoutMs: 5000,
      });
      expect(result).toEqual({ stdout: 'partial', stderr: 'boom', exitCode: 7 });
    } finally {
      restore();
    }
  });

  it("explicit platform 'mac' on a LINUX host keeps the pre-existing host-exec shim (no seatbelt)", async () => {
    const restore = stubPlatform('linux');
    try {
      mockExecSuccess();
      await runInSandbox({
        command: 'echo hi',
        workspaceDir: WS,
        policy,
        timeoutMs: 5000,
        platform: 'mac',
      });
      const [bin] = execFileMock.mock.calls[0] as [string];
      expect(bin).toBe('/bin/bash'); // runUnsandboxed, exactly as before
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// darwin host: Seatbelt runner
// ---------------------------------------------------------------------------

describe('runInSandbox on darwin (Seatbelt)', () => {
  it('routes to sandbox-exec with a -p profile and /bin/bash -c', async () => {
    const restore = stubPlatform('darwin');
    try {
      mockExecSuccess('mac-ok\n');
      const result = await runInSandbox({
        command: 'echo hi',
        workspaceDir: WS,
        policy,
        timeoutMs: 5000,
      });
      expect(result).toEqual({ stdout: 'mac-ok\n', stderr: '', exitCode: 0 });
      const [bin, args] = execFileMock.mock.calls[0] as [string, string[]];
      expect(bin).toBe(SANDBOX_EXEC_BIN);
      expect(args[0]).toBe('-p');
      expect(args[2]).toBe('/bin/bash');
      expect(args[3]).toBe('-c');
      // Same env-scrub + ulimit contract as the bwrap path (minus -v on mac)
      expect(args[4]).toContain('ulimit -SHt');
      expect(args[4]).not.toContain('ulimit -SHv');
      const [, , opts] = execFileMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv; timeout: number }];
      expect(opts.env['HOME']).toBe('/workspace');
      expect(opts.env['USER']).toBe('sandbox');
      expect(opts.timeout).toBe(5000);
    } finally {
      restore();
    }
  });

  it('SUDO_SANDBOX_ALLOW_UNCONFINED=1 runs unsandboxed (explicit opt-in) on darwin', async () => {
    const restore = stubPlatform('darwin');
    try {
      process.env['SUDO_SANDBOX_ALLOW_UNCONFINED'] = '1';
      mockExecSuccess();
      await runInSandbox({ command: 'echo hi', workspaceDir: WS, policy, timeoutMs: 5000 });
      const [bin] = execFileMock.mock.calls[0] as [string];
      expect(bin).toBe('/bin/bash');
    } finally {
      restore();
    }
  });

  it('sandbox-exec ENOENT produces an actionable exit-127 error', async () => {
    const restore = stubPlatform('darwin');
    try {
      mockExecError({ code: 'ENOENT' });
      const result = await runInSandbox({ command: 'echo hi', workspaceDir: WS, policy, timeoutMs: 5000 });
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain('sandbox-exec not found');
    } finally {
      restore();
    }
  });

  it('nonzero exit codes pass through on the seatbelt path', async () => {
    const restore = stubPlatform('darwin');
    try {
      mockExecError({ code: 3, stdout: '', stderr: 'nope' });
      const result = await runInSandbox({ command: 'exit 3', workspaceDir: WS, policy, timeoutMs: 5000 });
      expect(result).toEqual({ stdout: '', stderr: 'nope', exitCode: 3 });
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Seatbelt profile translation
// ---------------------------------------------------------------------------

describe('buildSeatbeltProfile', () => {
  it('is deny-default with writes confined to the workspace', () => {
    const profile = buildSeatbeltProfile(WS, { ...policy, network: 'none' });
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(deny default)');
    expect(profile).toContain(`(allow file-write* (subpath "${WS}") (subpath "/private/tmp"))`);
    expect(profile).toContain('(deny network*)');
  });

  it("network 'host' allows network (mirrors omitting --unshare-net)", () => {
    const profile = buildSeatbeltProfile(WS, { ...policy, network: 'host' });
    expect(profile).toContain('(allow network*)');
    expect(profile).not.toContain('(deny network*)');
  });

  it('does NOT grant blanket file-read of the host filesystem', () => {
    const profile = buildSeatbeltProfile(WS, policy);
    // read access must be an allowlist of subpaths, never a bare (allow file-read*)
    expect(profile).not.toMatch(/\(allow file-read\*\)\s*$/m);
    expect(profile).toContain('(subpath "/usr")');
    expect(profile).toContain(`(subpath "${WS}")`);
  });

  it('includes validated extra binds and rejects unsafe ones', () => {
    const realpath = (p: string): string => p;
    const withBinds = buildSeatbeltProfile(
      WS,
      { ...policy, extraReadOnlyBinds: ['/opt/python'], extraWritableBinds: [`${WS}/out`] },
      realpath,
    );
    expect(withBinds).toContain('(subpath "/opt/python")');
    expect(withBinds).toContain(`(subpath "${WS}/out")`);

    expect(() =>
      buildSeatbeltProfile(WS, { ...policy, extraReadOnlyBinds: ['/etc'] }, realpath),
    ).toThrow(/unsafe/);
  });

  it('escapes quotes in paths embedded in the profile', () => {
    const tricky = '/tmp/ws-"quoted"';
    const profile = buildSeatbeltProfile(tricky, policy);
    expect(profile).toContain('/tmp/ws-\\"quoted\\"');
  });
});

// ---------------------------------------------------------------------------
// ulimit wrapper platform variants
// ---------------------------------------------------------------------------

describe('buildUlimitWrappedCommand platform variants', () => {
  it('linux (default) output is byte-for-byte the historical string', () => {
    const wrapped = buildUlimitWrappedCommand('echo hi', policy);
    expect(wrapped).toBe(
      'ulimit -SHt 30; ulimit -SHf 2097152; ulimit -SHu 64; ulimit -SHv 4194304; echo hi',
    );
  });

  it('mac omits only the unsupported -v (RLIMIT_AS) cap', () => {
    const wrapped = buildUlimitWrappedCommand('echo hi', policy, 'mac');
    expect(wrapped).toBe('ulimit -SHt 30; ulimit -SHf 2097152; ulimit -SHu 64; echo hi');
  });
});

// ---------------------------------------------------------------------------
// buildSeatbeltArgs
// ---------------------------------------------------------------------------

describe('buildSeatbeltArgs', () => {
  it('produces [-p, <profile>, /bin/bash, -c, <ulimit-wrapped cmd>]', () => {
    const args = buildSeatbeltArgs('echo hi', WS, policy);
    expect(args).toHaveLength(5);
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe(buildSeatbeltProfile(WS, policy));
    expect(args.slice(2, 4)).toEqual(['/bin/bash', '-c']);
    expect(args[4]).toBe(buildUlimitWrappedCommand('echo hi', policy, 'mac'));
  });
});
