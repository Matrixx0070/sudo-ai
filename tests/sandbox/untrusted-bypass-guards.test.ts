/**
 * Spec 8 re-audit: exec paths that could bypass the untrusted-tier container
 * must fail closed when policy.requireIsolatedBackend is set.
 *
 * A: runInSandbox + SUDO_SANDBOX_DISABLE=1 (operator kill-switch) must NOT run
 *    an untrusted command unsandboxed on the host.
 * B: code.js-exec (host Worker+vm) must refuse untrusted turns.
 * C: system.shell.start (host bg shell) must refuse untrusted turns.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInSandbox } from '../../src/core/sandbox/sandbox-runner.js';
import { DEFAULT_SANDBOX_POLICY } from '../../src/core/sandbox/sandbox-types.js';
import type { ToolContext } from '../../src/core/tools/types.js';

const untrustedPolicy = {
  ...DEFAULT_SANDBOX_POLICY,
  execBackend: 'docker',
  requireIsolatedBackend: true,
  network: 'none' as const,
};

const untrustedCtx = {
  sessionId: 'hook:test',
  workingDir: process.cwd(),
  workspaceDir: process.cwd(),
  sandboxPolicy: untrustedPolicy,
  config: null,
  logger: console,
  isOwner: false,
  channel: 'hook',
} as unknown as ToolContext;

afterEach(() => {
  delete process.env['SUDO_SANDBOX_DISABLE'];
});

describe('A: SUDO_SANDBOX_DISABLE cannot bypass required isolation', () => {
  it('refuses (exit 126) instead of running unsandboxed on host', async () => {
    process.env['SUDO_SANDBOX_DISABLE'] = '1';
    const res = await runInSandbox({
      command: 'echo should-not-run',
      workspaceDir: process.cwd(),
      timeoutMs: 5000,
      policy: untrustedPolicy,
    });
    expect(res.exitCode).toBe(126);
    expect(res.stderr).toMatch(/requires container isolation/i);
    expect(res.stdout).not.toContain('should-not-run');
  });
});

describe('B: code.js-exec refuses untrusted turns (host vm is not a boundary)', () => {
  it('returns untrusted_tier_refused without executing', async () => {
    const { jsExecTool } = await import('../../src/core/tools/builtin/code/tools/js-exec.js');
    const res = await jsExecTool.execute({ code: 'globalThis.__pwned = 1; 42' }, untrustedCtx);
    expect(res.success).toBe(false);
    expect((res.data as { error?: string }).error).toBe('untrusted_tier_refused');
    expect((globalThis as Record<string, unknown>)['__pwned']).toBeUndefined();
  });
});

describe('C: system.shell.start refuses untrusted turns (host bg shell)', () => {
  it('returns untrusted_tier_refused without spawning', async () => {
    const mod = await import('../../src/core/tools/builtin/system/bg-shell/index.js');
    const start = mod.BG_SHELL_TOOLS.find((t) => t.name === 'system.shell.start')!;
    const res = await start.execute({ command: 'sleep 60' }, untrustedCtx);
    expect(res.success).toBe(false);
    expect((res.data as { error?: string }).error).toBe('untrusted_tier_refused');
  });
});
