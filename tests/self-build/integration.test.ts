/**
 * @file tests/self-build/integration.test.ts
 * @description Integration tests for Wave SelfBuild Builder L deliverables:
 *   - isProtectedPath utility correctness
 *   - meta.self-modify PROTECTED_PATHS deny-list (doEditFile / doWriteFile)
 *   - meta.self-modify build/restart/full-cycle blocked when SUDO_SELF_BUILD_MODE=1
 *   - handleSelfBuildTick short-circuits when SUDO_SELF_BUILD_MODE is unset
 *   - SUDO_SELFBUILD_ALLOW_PROTECTED escape hatch permits protected-path edits
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Save / restore process.env around each test
// ---------------------------------------------------------------------------

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
});

afterEach(() => {
  // Restore env to avoid leaking between tests
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

// ---------------------------------------------------------------------------
// 1. isProtectedPath — positive and negative
// ---------------------------------------------------------------------------

describe('isProtectedPath', () => {
  it('returns true for self-build orchestrator path', async () => {
    const { isProtectedPath } = await import('../../src/core/self-build/protected-paths.js');
    expect(isProtectedPath('src/core/self-build/orchestrator.ts')).toBe(true);
  });

  it('returns true for alignment-aggregator.ts', async () => {
    const { isProtectedPath } = await import('../../src/core/self-build/protected-paths.js');
    expect(isProtectedPath('src/core/agent/alignment-aggregator.ts')).toBe(true);
  });

  it('returns true for .githooks/ prefix', async () => {
    const { isProtectedPath } = await import('../../src/core/self-build/protected-paths.js');
    expect(isProtectedPath('.githooks/pre-commit')).toBe(true);
  });

  it('returns false for a regular source file', async () => {
    const { isProtectedPath } = await import('../../src/core/self-build/protected-paths.js');
    expect(isProtectedPath('src/core/brain/brain.ts')).toBe(false);
  });

  it('returns false for an empty string', async () => {
    const { isProtectedPath } = await import('../../src/core/self-build/protected-paths.js');
    expect(isProtectedPath('')).toBe(false);
  });

  it('is case-insensitive (uppercase bypass attempt)', async () => {
    const { isProtectedPath } = await import('../../src/core/self-build/protected-paths.js');
    expect(isProtectedPath('SRC/CORE/SELF-BUILD/orchestrator.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. meta.self-modify rejects a PROTECTED_PATH edit
// ---------------------------------------------------------------------------

describe('meta.self-modify — protected path guard', () => {
  // We test the doEditFile / doWriteFile path by calling the tool's execute()
  // with a protected path. The tool reads the file before editing, so we need
  // to ensure the guard fires BEFORE the file-system read (it does — abs check
  // comes first, then isProtectedPath check before existsSync / readFileSync).

  it('rejects edit-file targeting self-modify.ts (itself)', async () => {
    delete process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'];
    const { selfModifyTool } = await import(
      '../../src/core/tools/builtin/meta/self-modify.js'
    );
    const result = await selfModifyTool.execute(
      {
        action: 'edit-file',
        path: 'src/core/tools/builtin/meta/self-modify.ts',
        oldText: 'anything',
        newText: 'replacement',
      },
      { sessionId: 'test-session', userId: 'test', channel: 'web' } as never,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/protected during self-build/i);
  });

  it('rejects write-file targeting alignment-aggregator.ts', async () => {
    delete process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'];
    const { selfModifyTool } = await import(
      '../../src/core/tools/builtin/meta/self-modify.js'
    );
    const result = await selfModifyTool.execute(
      {
        action: 'write-file',
        path: 'src/core/agent/alignment-aggregator.ts',
        content: 'export {}',
      },
      { sessionId: 'test-session', userId: 'test', channel: 'web' } as never,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/protected during self-build/i);
  });

  it('allows edit-file on a non-protected path (e.g. README.md)', async () => {
    delete process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'];
    const { selfModifyTool } = await import(
      '../../src/core/tools/builtin/meta/self-modify.js'
    );
    // README.md is NOT in PROTECTED_PATHS — guard should not block it.
    // The file may or may not exist on disk; we expect either
    //   success:true (file found and edited) OR
    //   success:false with "File not found" (not "protected")
    const result = await selfModifyTool.execute(
      {
        action: 'edit-file',
        path: 'README.md',
        oldText: 'NONEXISTENT_PLACEHOLDER_TEXT_12345',
        newText: 'replacement',
      },
      { sessionId: 'test-session', userId: 'test', channel: 'web' } as never,
    );
    // Should NOT be a "protected" block — any other outcome is acceptable
    expect(result.output).not.toMatch(/protected during self-build/i);
  });

  it('SUDO_SELFBUILD_ALLOW_PROTECTED=1 bypasses the guard', async () => {
    process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'] = '1';
    const { selfModifyTool } = await import(
      '../../src/core/tools/builtin/meta/self-modify.js'
    );
    // Still expect file-system outcome (not a guard block), e.g. "File not found"
    const result = await selfModifyTool.execute(
      {
        action: 'edit-file',
        path: 'src/core/agent/alignment-aggregator.ts',
        oldText: 'NONEXISTENT_PLACEHOLDER_TEXT_12345',
        newText: 'replacement',
      },
      { sessionId: 'test-session', userId: 'test', channel: 'web' } as never,
    );
    expect(result.output).not.toMatch(/protected during self-build/i);
  });
});

// ---------------------------------------------------------------------------
// 3. meta.self-modify blocks build/restart/full-cycle when SUDO_SELF_BUILD_MODE=1
// ---------------------------------------------------------------------------

describe('meta.self-modify — build/restart/full-cycle blocked in self-build mode', () => {
  it('rejects build action when SUDO_SELF_BUILD_MODE=1', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const { selfModifyTool } = await import(
      '../../src/core/tools/builtin/meta/self-modify.js'
    );
    const result = await selfModifyTool.execute(
      { action: 'build' },
      { sessionId: 'test-session', userId: 'test', channel: 'web' } as never,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/SUDO_SELF_BUILD_MODE=1/);
  });

  it('rejects restart action when SUDO_SELF_BUILD_MODE=1', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const { selfModifyTool } = await import(
      '../../src/core/tools/builtin/meta/self-modify.js'
    );
    const result = await selfModifyTool.execute(
      { action: 'restart' },
      { sessionId: 'test-session', userId: 'test', channel: 'web' } as never,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/SUDO_SELF_BUILD_MODE=1/);
  });

  it('rejects full-cycle action when SUDO_SELF_BUILD_MODE=1', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const { selfModifyTool } = await import(
      '../../src/core/tools/builtin/meta/self-modify.js'
    );
    const result = await selfModifyTool.execute(
      {
        action: 'full-cycle',
        path: 'README.md',
        oldText: 'anything',
        newText: 'replacement',
      },
      { sessionId: 'test-session', userId: 'test', channel: 'web' } as never,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/SUDO_SELF_BUILD_MODE=1/);
  });

  it('does NOT block history action when SUDO_SELF_BUILD_MODE=1 (only build/restart/full-cycle are blocked)', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    const { selfModifyTool } = await import(
      '../../src/core/tools/builtin/meta/self-modify.js'
    );
    const result = await selfModifyTool.execute(
      { action: 'history' },
      { sessionId: 'test-session', userId: 'test', channel: 'web' } as never,
    );
    // history action should not be blocked by SUDO_SELF_BUILD_MODE guard
    expect(result.output).not.toMatch(/SUDO_SELF_BUILD_MODE=1/);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. handleSelfBuildTick short-circuits when SUDO_SELF_BUILD_MODE is unset
// ---------------------------------------------------------------------------

vi.mock('../../src/core/self-build/orchestrator.js', () => ({
  runSelfBuildTick: vi.fn().mockResolvedValue({ status: 'disabled' }),
}));

describe('handleSelfBuildTick — mode guard', () => {
  it('returns null when SUDO_SELF_BUILD_MODE is not set', async () => {
    delete process.env['SUDO_SELF_BUILD_MODE'];
    const { handleSelfBuildTick } = await import(
      '../../src/core/self-build/cron-entry.js'
    );
    const result = await handleSelfBuildTick({
      agentLoop: { run: vi.fn().mockResolvedValue({ text: 'ok' }) },
      mindDb: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(result).toBeNull();
  });
});
