/**
 * Tests for the pluggable exec-backend abstraction (gap #27).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerExecBackend,
  getRegisteredExecBackend,
  listExecBackends,
  clearExecBackends,
  selectExecBackendName,
  resolveExecBackend,
  type ExecBackend,
} from '../../src/core/sandbox/exec-backend.js';
import { runInSandbox, exitCodeFromError } from '../../src/core/sandbox/sandbox-runner.js';
import { DEFAULT_SANDBOX_POLICY } from '../../src/core/sandbox/sandbox-types.js';

const fakeBackend: ExecBackend = {
  name: 'fake',
  run: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
};

beforeEach(() => clearExecBackends());
afterEach(() => {
  clearExecBackends();
  delete process.env['SUDO_EXEC_BACKEND'];
  delete process.env['SUDO_SANDBOX_DISABLE'];
  delete process.env['SUDO_DOCKER_BIN'];
});

describe('exec-backend registry', () => {
  it('registers and retrieves a backend', () => {
    registerExecBackend(fakeBackend);
    expect(getRegisteredExecBackend('fake')).toBe(fakeBackend);
    expect(listExecBackends()).toContain('fake');
  });
});

describe('selectExecBackendName', () => {
  it('defaults to local when unset', () => {
    delete process.env['SUDO_EXEC_BACKEND'];
    expect(selectExecBackendName()).toBe('local');
  });

  it('lowercases and trims the env value', () => {
    process.env['SUDO_EXEC_BACKEND'] = '  Docker ';
    expect(selectExecBackendName()).toBe('docker');
  });
});

describe('resolveExecBackend', () => {
  it('returns null for the default local/bwrap path', async () => {
    expect(await resolveExecBackend('local')).toBeNull();
    expect(await resolveExecBackend('bwrap')).toBeNull();
  });

  it('returns a registered custom backend', async () => {
    registerExecBackend(fakeBackend);
    expect(await resolveExecBackend('fake')).toBe(fakeBackend);
  });

  it('lazy-loads the built-in docker backend on first use', async () => {
    const b = await resolveExecBackend('docker');
    expect(b).not.toBeNull();
    expect(b!.name).toBe('docker');
    // Cached afterwards.
    expect(getRegisteredExecBackend('docker')).toBe(b);
  });

  it('returns null for an unknown backend (caller falls back to bwrap)', async () => {
    expect(await resolveExecBackend('nope')).toBeNull();
  });
});

describe('runInSandbox dispatch', () => {
  it('routes through the selected backend (SUDO_EXEC_BACKEND=docker)', async () => {
    process.env['SUDO_EXEC_BACKEND'] = 'docker';
    process.env['SUDO_DOCKER_BIN'] = '/nonexistent/docker-xyz';
    try {
      const res = await runInSandbox({
        command: 'echo hi',
        workspaceDir: '/tmp',
        policy: { ...DEFAULT_SANDBOX_POLICY },
        timeoutMs: 5000,
      });
      // Proves the dispatch reached the docker backend (missing-binary path).
      expect(res.exitCode).toBe(127);
      expect(res.stderr).toContain('not found');
    } finally {
      delete process.env['SUDO_EXEC_BACKEND'];
      delete process.env['SUDO_DOCKER_BIN'];
    }
  });

  it('kill-switch SUDO_SANDBOX_DISABLE=1 wins over SUDO_EXEC_BACKEND=docker', async () => {
    process.env['SUDO_SANDBOX_DISABLE'] = '1';
    process.env['SUDO_EXEC_BACKEND'] = 'docker';
    process.env['SUDO_DOCKER_BIN'] = '/nonexistent/docker-xyz';
    try {
      const res = await runInSandbox({
        command: 'echo precedence',
        workspaceDir: '/tmp',
        policy: { ...DEFAULT_SANDBOX_POLICY },
        timeoutMs: 5000,
      });
      // Ran unsandboxed on the host — NOT routed to the missing docker binary.
      // The docker path would have returned exit 127 / 'not found'; instead the
      // command actually executed, proving the kill-switch pre-empted dispatch.
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('precedence');
    } finally {
      delete process.env['SUDO_SANDBOX_DISABLE'];
      delete process.env['SUDO_EXEC_BACKEND'];
      delete process.env['SUDO_DOCKER_BIN'];
    }
  });

  it('propagates a config-time throw from the selected backend (never falls through to host exec)', async () => {
    registerExecBackend({
      name: 'boom',
      run: async () => {
        throw new Error('backend config error');
      },
    });
    process.env['SUDO_EXEC_BACKEND'] = 'boom';
    try {
      await expect(
        runInSandbox({
          command: 'echo hi',
          workspaceDir: '/tmp',
          policy: { ...DEFAULT_SANDBOX_POLICY },
          timeoutMs: 5000,
        }),
      ).rejects.toThrow('backend config error');
    } finally {
      delete process.env['SUDO_EXEC_BACKEND'];
    }
  });

  it('propagates the REAL nonzero exit code, not a collapsed 1 (regression: execFile puts it on .code)', async () => {
    // Exercises the host-exec path (runUnsandboxed); the bwrap + docker paths
    // share exitCodeFromError. Before the fix, .status-only reads forced every
    // nonzero exit to 1.
    process.env['SUDO_SANDBOX_DISABLE'] = '1';
    try {
      const res = await runInSandbox({
        command: 'echo out; exit 7',
        workspaceDir: '/tmp',
        policy: { ...DEFAULT_SANDBOX_POLICY },
        timeoutMs: 5000,
      });
      expect(res.exitCode).toBe(7);
      expect(res.stdout).toContain('out');
    } finally {
      delete process.env['SUDO_SANDBOX_DISABLE'];
    }
  });
});

describe('exitCodeFromError', () => {
  it('reads the numeric exit code from an execFile rejection (.code is the exit code)', () => {
    expect(exitCodeFromError({ code: 7 })).toBe(7);
    expect(exitCodeFromError({ code: 2 })).toBe(2);
  });

  it('falls back to .status (spawnSync shape) then to 1', () => {
    expect(exitCodeFromError({ status: 5 })).toBe(5);
    expect(exitCodeFromError({ code: 'ENOENT' })).toBe(1); // string code → not an exit code
    expect(exitCodeFromError({})).toBe(1);
  });
});
