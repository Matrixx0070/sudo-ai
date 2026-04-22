/**
 * git.status tool tests — 7 tests covering happy path, error path, and edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import of the modules under test
// ---------------------------------------------------------------------------

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../src/core/tools/builtin/system/exec.js', () => ({
  runCmd: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { runCmd } from '../../src/core/tools/builtin/system/exec.js';
import { gitStatusTool } from '../../src/core/tools/builtin/git-status/status.js';
import type { ToolContext } from '../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: `test-${Date.now()}`,
    workingDir: '/tmp',
    config: null,
    logger: null,
    ...overrides,
  };
}

const mockRunCmd = vi.mocked(runCmd);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('git.status tool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path: clean repo with ahead/behind on real git repo', async () => {
    mockRunCmd.mockResolvedValueOnce({
      stdout: '## main...origin/main [ahead 2, behind 1]\n',
      stderr: '',
      exitCode: 0,
    });

    const ctx = makeCtx();
    const result = await gitStatusTool.execute({ cwd: '/root/sudo-ai-v4' }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['branch']).toBe('main');
    expect(data['clean']).toBe(true);
    expect(data['ahead']).toBe(2);
    expect(data['behind']).toBe(1);
    expect(result.output).toBe('main: clean, ahead=2, behind=1');
  });

  it('exitCode 128 → not a git repo error', async () => {
    mockRunCmd.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: not a git repository',
      exitCode: 128,
    });

    const result = await gitStatusTool.execute({ cwd: '/tmp' }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not a git repo/);
    const data = result.data as Record<string, unknown>;
    expect(data['exitCode']).toBe(128);
  });

  it('relative cwd → absolute-required error (no runCmd call)', async () => {
    const result = await gitStatusTool.execute({ cwd: 'relative/path' }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/must be absolute/);
    expect(mockRunCmd).not.toHaveBeenCalled();
  });

  it('clean branch line "## main\\n" → clean:true, ahead:0, behind:0', async () => {
    mockRunCmd.mockResolvedValueOnce({
      stdout: '## main\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await gitStatusTool.execute({ cwd: '/root/sudo-ai-v4' }, makeCtx());

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['branch']).toBe('main');
    expect(data['clean']).toBe(true);
    expect(data['ahead']).toBe(0);
    expect(data['behind']).toBe(0);
  });

  it('ahead/behind parsing: [ahead 3, behind 1] → ahead:3, behind:1', async () => {
    mockRunCmd.mockResolvedValueOnce({
      stdout: '## main...origin/main [ahead 3, behind 1]\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await gitStatusTool.execute({ cwd: '/root/sudo-ai-v4' }, makeCtx());

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['ahead']).toBe(3);
    expect(data['behind']).toBe(1);
  });

  it('"## HEAD (no branch)" → branch:"HEAD"', async () => {
    mockRunCmd.mockResolvedValueOnce({
      stdout: '## HEAD (no branch)\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await gitStatusTool.execute({ cwd: '/root/sudo-ai-v4' }, makeCtx());

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['branch']).toBe('HEAD');
  });

  it('two untracked files → untrackedCount:2, clean:false', async () => {
    mockRunCmd.mockResolvedValueOnce({
      stdout: '## main...origin/main\n?? new-file.ts\n?? another.ts\n',
      stderr: '',
      exitCode: 0,
    });

    const result = await gitStatusTool.execute({ cwd: '/root/sudo-ai-v4' }, makeCtx());

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['untrackedCount']).toBe(2);
    expect(data['clean']).toBe(false);
    expect(result.output).toMatch(/2 dirty file\(s\)/);
  });
});
