/**
 * @file tests/meta/hot-deploy-selfbuild.test.ts
 * @description Tests for HIGH-2 fix: meta.hot-deploy is fully blocked during self-build mode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ToolContext } from '../../src/core/tools/types.js';

// Mock ToolRegistry before importing the tool
vi.mock('../../src/core/tools/registry.js', () => ({
  ToolRegistry: {
    getGlobal: vi.fn(() => ({
      register: vi.fn(),
      get: vi.fn(() => null),
    })),
    setGlobal: vi.fn(),
  },
}));

import { hotDeployTool } from '../../src/core/tools/builtin/meta/hot-deploy.js';

function makeCtx(): ToolContext {
  return {
    workingDir: '/root/sudo-ai-v4',
    sessionId: 'test-session',
    userId: 'test-user',
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    signal: undefined,
  } as unknown as ToolContext;
}

beforeEach(() => {
  delete process.env['SUDO_SELF_BUILD_MODE'];
  delete process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'];
});

afterEach(() => {
  delete process.env['SUDO_SELF_BUILD_MODE'];
  delete process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'];
});

describe('meta.hot-deploy — self-build mode block (HIGH-2)', () => {
  it('is blocked when SUDO_SELF_BUILD_MODE=1', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';

    const result = await hotDeployTool.execute(
      {
        skillName: 'custom.evil-tool',
        code: 'export const evilTool = { name: "custom.evil-tool", description: "x", execute: async () => ({success:true,output:"ok"}), parameters: {} };',
        overwrite: false,
      },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('blocked during self-build mode');
  });

  it('is blocked with any skill name during self-build mode', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';

    const result = await hotDeployTool.execute(
      { skillName: 'custom.another', code: '// something', overwrite: false },
      makeCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/SUDO_SELF_BUILD_MODE/);
  });

  it('is NOT blocked when SUDO_SELF_BUILD_MODE is unset', async () => {
    // Without SUDO_SELF_BUILD_MODE, the tool proceeds past the guard.
    // It will fail for other reasons (invalid skill name pattern or compilation)
    // but must NOT fail due to the self-build block.
    const result = await hotDeployTool.execute(
      { skillName: 'invalid', code: 'x', overwrite: false }, // will fail validation
      makeCtx(),
    );

    // Must not be the self-build block error
    expect(result.output).not.toContain('blocked during self-build mode');
  });

  it('is NOT blocked when SUDO_SELFBUILD_ALLOW_PROTECTED=1 overrides', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'] = '1';

    // Guard is bypassed; will fail for other reasons (e.g. compilation),
    // but must NOT be blocked by the self-build check.
    const result = await hotDeployTool.execute(
      { skillName: 'invalid', code: 'x', overwrite: false },
      makeCtx(),
    );

    expect(result.output).not.toContain('blocked during self-build mode');
  });
});
