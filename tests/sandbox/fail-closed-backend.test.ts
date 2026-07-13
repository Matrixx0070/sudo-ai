/**
 * Fail-closed dispatch (Feature 8): a policy that REQUIRES an isolation backend
 * must NOT downgrade to host bwrap when that backend can't be resolved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInSandbox } from '../../src/core/sandbox/sandbox-runner.js';
import { clearExecBackends } from '../../src/core/sandbox/exec-backend.js';
import { DEFAULT_SANDBOX_POLICY } from '../../src/core/sandbox/sandbox-types.js';

afterEach(() => {
  clearExecBackends();
  delete process.env['SUDO_EXEC_BACKEND'];
  delete process.env['SUDO_SANDBOX_DISABLE'];
});

describe('runInSandbox fail-closed for required isolation backend', () => {
  it('unresolvable required backend → exitCode 126, refuses host fallback', async () => {
    const res = await runInSandbox({
      command: 'echo should-not-run',
      workspaceDir: process.cwd(),
      timeoutMs: 5000,
      policy: {
        ...DEFAULT_SANDBOX_POLICY,
        execBackend: 'no-such-backend-xyz',
        requireIsolatedBackend: true,
      },
    });
    expect(res.exitCode).toBe(126);
    expect(res.stderr).toMatch(/required isolation backend|refusing to execute/i);
    expect(res.stdout).not.toContain('should-not-run');
  });
});
