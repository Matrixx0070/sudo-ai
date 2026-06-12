/**
 * @file self-build/deployment-hook.test.ts
 * @description Tests for DeploymentHook class.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock child_process before importing the module
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { DeploymentHook } from './deployment-hook.js';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockDeps() {
  return {
    githubIssues: {
      addComment: vi.fn().mockResolvedValue({ success: true }),
    },
    metrics: {
      recordEvent: vi.fn(),
    },
  };
}

type ExecResponse =
  | { type: 'success'; stdout: string; stderr: string }
  | { type: 'error'; error: Error }
  | { type: 'exit'; stdout: string; stderr: string; code: number };

let execQueue: ExecResponse[] = [];

function queueExec(...responses: ExecResponse[]) {
  execQueue.push(...responses);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeploymentHook', () => {
  let hook: DeploymentHook;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    vi.resetAllMocks();
    execQueue = [];
    let callIdx = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
      const response = execQueue[callIdx++];
      if (!response) {
        const callback = cb as (err: Error, stdout: string, stderr: string) => void;
        callback(new Error(`Unexpected execFile call #${callIdx}`), '', '');
        return;
      }
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      if (response.type === 'success') {
        callback(null, response.stdout, response.stderr);
      } else if (response.type === 'exit') {
        const err = new Error(response.stderr || 'Command failed') as Error & { status: number };
        err.status = response.code;
        callback(err, response.stdout, response.stderr);
      } else {
        callback(response.error, '', '');
      }
    });

    process.env['GITHUB_TOKEN'] = 'test-token';
    deps = createMockDeps();
    hook = new DeploymentHook(deps.githubIssues, deps.metrics);
  });

  afterEach(() => {
    delete process.env['GITHUB_TOKEN'];
    hook.cleanup();
  });

  describe('monitorPR', () => {
    it('starts polling interval for PR', () => {
      hook.monitorPR(42, 100);
      expect(deps.metrics.recordEvent).not.toHaveBeenCalled();
    });

    it('skips when kill-switch is enabled', () => {
      process.env['SUDO_AUTODEPLOY_DISABLE'] = '1';
      hook.monitorPR(42, 100);
      expect(deps.githubIssues.addComment).not.toHaveBeenCalled();
      delete process.env['SUDO_AUTODEPLOY_DISABLE'];
    });

    it('does not start duplicate monitor for same PR', () => {
      hook.monitorPR(42, 100);
      hook.monitorPR(42, 100);
    });
  });

  describe('stopMonitoring', () => {
    it('clears interval and removes from timers map', () => {
      hook.monitorPR(42, 100);
      hook.stopMonitoring(42);
    });

    it('no-op for non-existent PR', () => {
      expect(() => hook.stopMonitoring(999)).not.toThrow();
    });
  });

  describe('checkAndDeploy', () => {
    it('skips when kill-switch is enabled', async () => {
      process.env['SUDO_AUTODEPLOY_DISABLE'] = '1';
      await hook.checkAndDeploy(42, 100);
      expect(mockFetch).not.toHaveBeenCalled();
      delete process.env['SUDO_AUTODEPLOY_DISABLE'];
    });

    it('does nothing when PR is open', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: 'open', merged: false, head: { sha: 'abc123' } }),
      });

      await hook.checkAndDeploy(42, 100);

      expect(mockFetch).toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('runs CI and deploys when PR is merged', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: 'merged', merged: true, head: { sha: 'abc123' } }),
      });

      queueExec(
        { type: 'success', stdout: 'a1b2c3d4\n', stderr: '' },   // git rev-parse HEAD — known-good baseline captured before CI
        { type: 'success', stdout: 'lint ok', stderr: '' },
        { type: 'success', stdout: 'tests pass', stderr: '' },
        { type: 'success', stdout: 'pm2 reload ok', stderr: '' },
      );

      await hook.checkAndDeploy(42, 100);

      expect(mockExecFile).toHaveBeenCalledTimes(4);
      expect(deps.githubIssues.addComment).toHaveBeenCalledWith(
        100,
        expect.stringContaining('SUCCESS'),
      );
      expect(deps.metrics.recordEvent).toHaveBeenCalledWith('deployed', expect.any(Object));
    });

    it('rolls back when CI fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: 'merged', merged: true, head: { sha: 'abc123' } }),
      });

      queueExec(
        { type: 'success', stdout: 'lint ok', stderr: '' },
        { type: 'exit', stdout: '', stderr: 'test error', code: 1 },
        { type: 'success', stdout: 'reset ok', stderr: '' },
      );

      await hook.checkAndDeploy(42, 100);

      expect(mockExecFile).toHaveBeenCalledTimes(3);
      expect(deps.githubIssues.addComment).toHaveBeenCalledWith(
        100,
        expect.stringContaining('FAILED'),
      );
      expect(deps.metrics.recordEvent).toHaveBeenCalledWith('ci_failed', expect.any(Object));
    });

    it('handles GitHub API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      await hook.checkAndDeploy(42, 100);

      expect(deps.metrics.recordEvent).toHaveBeenCalledWith(
        'deploy_error',
        expect.objectContaining({ error: expect.any(String) }),
      );
    });
  });

  describe('runCI', () => {
    it('returns passed when lint and test succeed', async () => {
      queueExec(
        { type: 'success', stdout: 'lint ok', stderr: '' },
        { type: 'success', stdout: 'tests pass', stderr: '' },
      );

      const result = await hook.runCI();

      expect(result.passed).toBe(true);
      expect(result.output).toContain('tests pass');
    });

    it('returns failed when lint fails', async () => {
      queueExec({ type: 'exit', stdout: '', stderr: 'lint error', code: 1 });

      const result = await hook.runCI();

      expect(result.passed).toBe(false);
      expect(result.output).toContain('lint error');
    });

    it('returns failed when test fails', async () => {
      queueExec(
        { type: 'success', stdout: 'lint ok', stderr: '' },
        { type: 'exit', stdout: '', stderr: 'test error', code: 1 },
      );

      const result = await hook.runCI();

      expect(result.passed).toBe(false);
      expect(result.output).toContain('test error');
    });

    it('handles execFile exception', async () => {
      queueExec({ type: 'error', error: new Error('spawn failed') });

      const result = await hook.runCI();

      expect(result.passed).toBe(false);
      expect(result.output).toContain('spawn failed');
    });
  });

  describe('deploy', () => {
    it('returns deployed on success', async () => {
      queueExec({ type: 'success', stdout: 'pm2 ok', stderr: '' });

      const result = await hook.deploy();

      expect(result.success).toBe(true);
      expect(result.action).toBe('deployed');
    });

    it('returns failed on pm2 error', async () => {
      queueExec({ type: 'exit', stdout: '', stderr: 'pm2 error', code: 1 });

      const result = await hook.deploy();

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
    });

    it('handles execFile exception', async () => {
      queueExec({ type: 'error', error: new Error('pm2 not found') });

      const result = await hook.deploy();

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.output).toContain('pm2 not found');
    });
  });

  describe('rollback', () => {
    it('resets to previous commit', async () => {
      queueExec({ type: 'success', stdout: 'reset ok', stderr: '' });

      await hook.rollback('abc123');

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['reset', '--hard', 'abc123'],
        expect.objectContaining({ cwd: process.cwd() }),
        expect.any(Function),
      );
      expect(deps.metrics.recordEvent).toHaveBeenCalledWith('rolled_back', expect.any(Object));
    });

    it('throws on git error', async () => {
      queueExec({ type: 'error', error: new Error('git failed') });

      await expect(hook.rollback('abc123')).rejects.toThrow('git failed');
    });
  });

  describe('addDeploymentComment', () => {
    it('adds success comment to issue', async () => {
      await hook.addDeploymentComment(100, {
        success: true,
        action: 'deployed',
        output: 'Deployed successfully',
      });

      expect(deps.githubIssues.addComment).toHaveBeenCalledWith(
        100,
        expect.stringContaining('SUCCESS'),
      );
    });

    it('adds failure comment to issue', async () => {
      await hook.addDeploymentComment(100, {
        success: false,
        action: 'rolled-back',
        output: 'CI failed',
      });

      expect(deps.githubIssues.addComment).toHaveBeenCalledWith(
        100,
        expect.stringContaining('FAILED'),
      );
    });

    it('handles addComment error gracefully', async () => {
      deps.githubIssues.addComment.mockRejectedValueOnce(new Error('GitHub API error'));

      await expect(hook.addDeploymentComment(100, {
        success: true,
        action: 'deployed',
      })).resolves.toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('stops all active monitors', () => {
      hook.monitorPR(42, 100);
      hook.monitorPR(43, 101);
      hook.cleanup();
    });
  });
});
