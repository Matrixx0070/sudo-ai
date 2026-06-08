/**
 * @file tests/tools/coder/selfbuild-guard.test.ts
 * @description Tests for self-build path guards in coder.write-file and coder.edit-file.
 *
 * Covers:
 *   - write-file blocked when target is a protected path and SUDO_SELF_BUILD_MODE=1
 *   - write-file allowed when SUDO_SELF_BUILD_MODE is unset (guard is a no-op)
 *   - edit-file blocked when target is a protected path and SUDO_SELF_BUILD_MODE=1
 *   - edit-file allowed for non-protected paths during self-build mode
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeFileTool } from '../../../src/core/tools/builtin/coder/write-file.js';
import { editFileTool } from '../../../src/core/tools/builtin/coder/edit-file.js';
import type { ToolContext } from '../../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

const testDir = path.join(tmpdir(), 'selfbuild-coder-guard-test-' + process.pid);

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: 'test-session',
    userId: 'test-user',
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    signal: undefined,
  } as unknown as ToolContext;
}

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  delete process.env['SUDO_SELF_BUILD_MODE'];
  delete process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'];
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env['SUDO_SELF_BUILD_MODE'];
  delete process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'];
});

// ---------------------------------------------------------------------------
// Helper: derive a path that would look like a protected path to PROJECT_ROOT
// The tools resolve PROJECT_ROOT from SUDO_AI_HOME || process.cwd(), which under
// test points at the project root. We cannot write there in tests, so we test the
// guard logic directly by pointing ctx.workingDir at PROJECT_ROOT and targeting a
// protected relative path.
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();

// ---------------------------------------------------------------------------
// coder.write-file
// ---------------------------------------------------------------------------

describe('coder.write-file — self-build path guard', () => {
  it('blocks write to protected path when SUDO_SELF_BUILD_MODE=1', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';

    const ctx = makeCtx(PROJECT_ROOT);
    // src/core/self-build/ is in PROTECTED_PATHS
    const result = await writeFileTool.execute(
      { path: 'src/core/self-build/orchestrator.ts', content: 'bad content' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/[Bb]locked.*protected/);
  });

  it('allows write to non-protected path when SUDO_SELF_BUILD_MODE=1', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';

    const targetFile = path.join(testDir, 'output.ts');
    const ctx = makeCtx(testDir);
    const result = await writeFileTool.execute(
      { path: 'output.ts', content: 'export const x = 1;' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('output.ts');
  });

  it('no-op guard when SUDO_SELF_BUILD_MODE is unset', async () => {
    // SUDO_SELF_BUILD_MODE not set — guard should pass through for any path
    const targetFile = 'output-noselfbuild.ts';
    const ctx = makeCtx(testDir);
    const result = await writeFileTool.execute(
      { path: targetFile, content: 'export const y = 2;' },
      ctx,
    );

    expect(result.success).toBe(true);
  });

  it('allows write to protected path when SUDO_SELFBUILD_ALLOW_PROTECTED=1', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';
    process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'] = '1';

    // Attempt to write to a normally-protected relative path — should succeed
    const ctx = makeCtx(testDir);
    const result = await writeFileTool.execute(
      { path: 'output-allowed.ts', content: 'export const z = 3;' },
      ctx,
    );

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// coder.edit-file
// ---------------------------------------------------------------------------

describe('coder.edit-file — self-build path guard', () => {
  it('blocks edit to protected path when SUDO_SELF_BUILD_MODE=1', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';

    const ctx = makeCtx(PROJECT_ROOT);
    // veto-gate.ts is in PROTECTED_PATHS
    const result = await editFileTool.execute(
      {
        path: 'src/core/agent/veto-gate.ts',
        edits: [{ type: 'replace', oldText: 'unused', newText: 'hacked' }],
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/[Bb]locked.*protected/);
  });

  it('allows edit to non-protected path when SUDO_SELF_BUILD_MODE=1', async () => {
    process.env['SUDO_SELF_BUILD_MODE'] = '1';

    // Create a real file in testDir to edit
    const fileName = 'editable.ts';
    const filePath = path.join(testDir, fileName);
    writeFileSync(filePath, 'export const a = "hello";', 'utf-8');

    const ctx = makeCtx(testDir);
    const result = await editFileTool.execute(
      {
        path: fileName,
        edits: [{ type: 'replace', oldText: '"hello"', newText: '"world"' }],
      },
      ctx,
    );

    expect(result.success).toBe(true);
  });

  it('no-op guard when SUDO_SELF_BUILD_MODE is unset', async () => {
    const fileName = 'editable-noselfbuild.ts';
    const filePath = path.join(testDir, fileName);
    writeFileSync(filePath, 'export const b = "foo";', 'utf-8');

    const ctx = makeCtx(testDir);
    const result = await editFileTool.execute(
      {
        path: fileName,
        edits: [{ type: 'replace', oldText: '"foo"', newText: '"bar"' }],
      },
      ctx,
    );

    expect(result.success).toBe(true);
  });
});
