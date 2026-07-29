/**
 * @file path-guard.test.ts
 * @description AL8.0 R3 — direct tests for the tool-layer path guard, the
 * one AL8.5 boundary the Campaign-4 audit found untested. Covers: protected
 * paths blocked in self-build mode (raw AND symlink-resolved), non-protected
 * paths pass, the mode gate (no-op outside self-build mode), the documented
 * SUDO_SELFBUILD_ALLOW_PROTECTED escape hatch, and the destructive-action
 * block list.
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { blockIfProtected, blockIfSelfBuildMode } from '../../src/core/self-build/path-guard.js';

const savedEnv: Record<string, string | undefined> = {};
for (const k of ['SUDO_SELF_BUILD_MODE', 'SUDO_SELFBUILD_ALLOW_PROTECTED']) {
  savedEnv[k] = process.env[k];
}
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const root = mkdtempSync(path.join(tmpdir(), 'path-guard-'));
mkdirSync(path.join(root, 'src', 'core', 'self-build'), { recursive: true });
mkdirSync(path.join(root, 'src', 'core', 'workflows'), { recursive: true });
writeFileSync(path.join(root, 'src', 'core', 'self-build', 'orchestrator.ts'), '// protected');
writeFileSync(path.join(root, 'src', 'core', 'workflows', 'ok.ts'), '// fine');

beforeEach(() => {
  process.env['SUDO_SELF_BUILD_MODE'] = '1';
  delete process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'];
});

describe('blockIfProtected', () => {
  it('blocks a protected path in self-build mode with the path named', () => {
    const r = blockIfProtected(path.join(root, 'src/core/self-build/orchestrator.ts'), root);
    expect(r.blocked).toBe(true);
    expect((r as { error: string }).error).toMatch(/protected path during self-build.*self-build/);
  });

  it('blocks a SYMLINK that resolves into a protected path (traversal defense)', () => {
    const link = path.join(root, 'src', 'core', 'workflows', 'sneaky.ts');
    symlinkSync(path.join(root, 'src', 'core', 'self-build', 'orchestrator.ts'), link);
    const r = blockIfProtected(link, root);
    expect(r.blocked).toBe(true);
    expect((r as { error: string }).error).toMatch(/resolves to/);
  });

  it('blocks a protected path that does not exist yet (raw-path check)', () => {
    const r = blockIfProtected(path.join(root, 'src/core/self-build/new-file.ts'), root);
    expect(r.blocked).toBe(true);
  });

  it('passes non-protected paths', () => {
    expect(blockIfProtected(path.join(root, 'src/core/workflows/ok.ts'), root).blocked).toBe(false);
  });

  it('no-ops outside self-build mode', () => {
    delete process.env['SUDO_SELF_BUILD_MODE'];
    expect(blockIfProtected(path.join(root, 'src/core/self-build/orchestrator.ts'), root).blocked).toBe(false);
  });

  it('honors the documented SUDO_SELFBUILD_ALLOW_PROTECTED escape hatch', () => {
    process.env['SUDO_SELFBUILD_ALLOW_PROTECTED'] = '1';
    expect(blockIfProtected(path.join(root, 'src/core/self-build/orchestrator.ts'), root).blocked).toBe(false);
  });
});

describe('blockIfSelfBuildMode', () => {
  const BLOCKED = ['restart', 'wipe'] as const;

  it('blocks listed destructive actions in self-build mode, names tool + action', () => {
    const r = blockIfSelfBuildMode('restart', 'meta.hot-deploy', BLOCKED);
    expect(r.blocked).toBe(true);
    expect((r as { error: string }).error).toMatch(/meta\.hot-deploy.*"restart".*self-build mode/);
  });

  it('passes unlisted actions, and everything outside self-build mode', () => {
    expect(blockIfSelfBuildMode('status', 'meta.hot-deploy', BLOCKED).blocked).toBe(false);
    delete process.env['SUDO_SELF_BUILD_MODE'];
    expect(blockIfSelfBuildMode('restart', 'meta.hot-deploy', BLOCKED).blocked).toBe(false);
  });
});
