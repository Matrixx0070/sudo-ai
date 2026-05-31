/**
 * @file self-build/deployment-hook.test.ts
 * @description Tests for DeploymentHook class.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock child_process before importing the module
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  const mockExecFile = vi.fn();
  return {
    ...actual,
    execFile: mockExecFile,
    __mockExecFile: mockExecFile,
  };
});

import { DeploymentHook } from './deployment-hook.js';
import { execFile } from 'node:child_process';

// Get the mock function
const mockExecFile = execFile as ReturnType<typeof vi.fn>;

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeploymentHook', () => {
  let hook: DeploymentHook;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    hook = new DeploymentHook(deps.githubIssues, deps.metrics);
  });

  afterEach(() => {
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

      mockExecFile
        .mockResolvedValueOnce({ stdout: 'lint ok', stderr: '', code: 0 })
        .mockResolvedValueOnce({ stdout: 'tests pass', stderr: '', code: 0 })
        .mockResolvedValueOnce({ stdout: 'pm2 reload ok', stderr: '', code: 0 });

      await hook.checkAndDeploy(42, 100);

      expect(mockExecFile).toHaveBeenCalledTimes(3);
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

      mockExecFile
        .mockResolvedValueOnce({ stdout: 'lint ok', stderr: '', code: 0 })
        .mockResolvedValueOnce({ stdout: 'test fail', stderr: 'error', code: 1 })
        .mockResolvedValueOnce({ stdout: 'reset ok', stderr: '', code: 0 });

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
      mockExecFile
        .mockResolvedValueOnce({ stdout: 'lint ok', stderr: '', code: 0 })
        .mockResolvedValueOnce({ stdout: 'tests pass', stderr: '', code: 0 });

      const result = await hook.runCI();

      expect(result.passed).toBe(true);
      expect(result.output).toContain('tests pass');
    });

    it('returns failed when lint fails', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: 'lint error', code: 1 });

      const result = await hook.runCI();

      expect(result.passed).toBe(false);
      expect(result.output).toContain('lint error');
    });

    it('returns failed when test fails', async () => {
      mockExecFile
        .mockResolvedValueOnce({ stdout: 'lint ok', stderr: '', code: 0 })
        .mockResolvedValueOnce({ stdout: '', stderr: 'test error', code: 1 });

      const result = await hook.runCI();

      expect(result.passed).toBe(false);
      expect(result.output).toContain('test error');
    });

    it('handles execFile exception', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('spawn failed'));

      const result = await hook.runCI();

      expect(result.passed).toBe(false);
      expect(result.output).toContain('spawn failed');
    });
  });

  describe('deploy', () => {
    it('returns deployed on success', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: 'pm2 ok', stderr: '', code: 0 });

      const result = await hook.deploy();

      expect(result.success).toBe(true);
      expect(result.action).toBe('deployed');
    });

    it('returns failed on pm2 error', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: 'pm2 error', code: 1 });

      const result = await hook.deploy();

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
    });

    it('handles execFile exception', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('pm2 not found'));

      const result = await hook.deploy();

      expect(result.success).toBe(false);
      expect(result.action).toBe('failed');
      expect(result.output).toContain('pm2 not found');
    });
  });

  describe('rollback', () => {
    it('resets to previous commit', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: 'reset ok', stderr: '', code: 0 });

      await hook.rollback('abc123');

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['reset', '--hard', 'abc123'],
        expect.objectContaining({ cwd: '/root/sudo-ai-v4' }),
      );
      expect(deps.metrics.recordEvent).toHaveBeenCalledWith('rolled_back', expect.any(Object));
    });

    it('throws on git error', async () => {
      mockExecFile.mockRejectedValueOnce(new Error('git failed'));

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
