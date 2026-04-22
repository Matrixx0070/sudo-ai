/**
 * @file tests/meta/self-update-selfbuild.test.ts
 * @description Tests for MEDIUM-1 fix: meta.self-update destructive actions blocked during self-build mode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ToolContext } from '../../src/core/tools/types.js';
import { selfUpdateTool } from '../../src/core/tools/builtin/meta/self-update.js';

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

describe('meta.self-update — self-build mode destructive action block (MEDIUM-1)', () => {
  const BLOCKED_ACTIONS = ['pull', 'full-update', 'rollback', 'build'];

  for (const action of BLOCKED_ACTIONS) {
    it(`blocks "${action}" action when SUDO_SELF_BUILD_MODE=1`, async () => {
      process.env['SUDO_SELF_BUILD_MODE'] = '1';

      const result = await selfUpdateTool.execute(
        { action, confirm: true },
        makeCtx(),
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain(`"${action}"`);
      expect(result.output).toContain('blocked during self-build mode');
    });
  }

  it('allows "status" action during self-build mode', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';

    // "status" reads git log — may fail if git is unavailable in sandbox,
    // but must NOT fail due to the self-build block.
    const result = await selfUpdateTool.execute(
      { action: 'status' },
      makeCtx(),
    );

    // Verify not blocked by the self-build guard
    expect(result.output).not.toContain('blocked during self-build mode');
  });

  it('allows "check" action during self-build mode', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';

    const result = await selfUpdateTool.execute(
      { action: 'check' },
      makeCtx(),
    );

    expect(result.output).not.toContain('blocked during self-build mode');
  });

  it('does NOT block read-only "check" when SUDO_SELF_BUILD_MODE is unset', async () => {
    // Guard is a complete no-op when SUDO_SELF_BUILD_MODE is unset.
    const result = await selfUpdateTool.execute(
      { action: 'check' },
      makeCtx(),
    );

    expect(result.output).not.toContain('blocked during self-build mode');
  });

  it('does NOT block "check" when SUDO_SELFBUILD_ALLOW_PROTECTED=1 overrides', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'] = '1';

    // Override allows all actions including "check"; this is a read-only fast check.
    const result = await selfUpdateTool.execute(
      { action: 'check' },
      makeCtx(),
    );

    expect(result.output).not.toContain('blocked during self-build mode');
  });
});
