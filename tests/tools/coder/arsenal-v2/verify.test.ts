/**
 * @file verify.test.ts
 * @description Tests for arsenal-v2/verify — vitest --related runner.
 *
 * The vitest binary itself is never invoked here. We stub it with a tiny shell
 * script in a temp project root that echoes a synthetic summary block and
 * exits with whatever code the test scenario requires. That lets us exercise
 * the parser + skip-conditions deterministically without paying the real test
 * suite's runtime.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runRelatedTests,
  parseVitestSummary,
} from '../../../../src/core/tools/builtin/coder/arsenal-v2/verify.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arsenal-v2-verify-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Drop an executable shell script that mimics the vitest CLI. */
async function fakeVitest(stdout: string, exit: number): Promise<string> {
  const binDir = path.join(root, 'node_modules', '.bin');
  await mkdir(binDir, { recursive: true });
  const bin = path.join(binDir, 'vitest');
  // The script ignores its args and just prints + exits — that's enough for
  // the verify wrapper, which only inspects stdout + exit code.
  const escaped = stdout.replace(/'/g, `'\\''`);
  await writeFile(bin, `#!/usr/bin/env bash\nprintf '%s' '${escaped}'\nexit ${exit}\n`, 'utf-8');
  await chmod(bin, 0o755);
  return bin;
}

describe('parseVitestSummary', () => {
  it('parses a clean run', () => {
    const out = ' Test Files  4 passed (4)\n      Tests  42 passed (42)\n';
    expect(parseVitestSummary(out)).toEqual({ tests: 42, failures: 0 });
  });
  it('parses a mixed run with failures', () => {
    const out = ' Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 40 passed (42)\n';
    expect(parseVitestSummary(out)).toEqual({ tests: 42, failures: 2 });
  });
  it('strips ANSI color codes', () => {
    const out = '\x1B[31m Test Files  1 failed | 3 passed (4)\x1B[0m\n\x1B[32m      Tests  2 failed | 40 passed (42)\x1B[0m';
    expect(parseVitestSummary(out)).toEqual({ tests: 42, failures: 2 });
  });
  it('returns sentinel values when no summary present', () => {
    expect(parseVitestSummary('something else entirely')).toEqual({ tests: -1, failures: 0 });
  });
  it('handles failures with no totals visible', () => {
    expect(parseVitestSummary('      Tests  3 failed\n')).toEqual({ tests: -1, failures: 3 });
  });
});

describe('runRelatedTests — skip paths', () => {
  it('skips with no_files when changedFiles is empty', () => {
    const r = runRelatedTests([], { projectRoot: root, env: {} });
    expect(r.ran).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe('no_files');
    expect(r.passed).toBe(false);
    expect(r.summary).toMatch(/no files changed/);
  });

  it('skips with disabled_env when SUDO_ARSENAL_V2_SKIP_TESTS=1', () => {
    const r = runRelatedTests(['src/foo.ts'], {
      projectRoot: root,
      env: { SUDO_ARSENAL_V2_SKIP_TESTS: '1' },
    });
    expect(r.skipReason).toBe('disabled_env');
    expect(r.summary).toMatch(/SUDO_ARSENAL_V2_SKIP_TESTS=1/);
  });

  it('skips with binary_missing when vitest is absent', () => {
    const r = runRelatedTests(['src/foo.ts'], {
      projectRoot: root,
      env: {},
      vitestBin: path.join(root, 'definitely-not-here'),
    });
    expect(r.skipReason).toBe('binary_missing');
    expect(r.summary).toMatch(/vitest not available/);
  });
});

describe('runRelatedTests — green path', () => {
  it('reports passed when vitest exits 0', async () => {
    await fakeVitest(' Test Files  2 passed (2)\n      Tests  17 passed (17)\n', 0);
    const r = runRelatedTests(['src/foo.ts', 'src/bar.ts'], {
      projectRoot: root,
      env: {},
    });
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.testsRun).toBe(17);
    expect(r.failures).toBe(0);
    expect(r.summary).toMatch(/17 passed/);
  });

  it('handles --passWithNoTests no-summary output', async () => {
    await fakeVitest('No test files found, exiting with code 0\n', 0);
    const r = runRelatedTests(['src/foo.ts'], { projectRoot: root, env: {} });
    expect(r.passed).toBe(true);
    expect(r.testsRun).toBe(-1);
    expect(r.summary).toMatch(/clean/);
  });
});

describe('runRelatedTests — red path', () => {
  it('reports failures when vitest exits non-zero', async () => {
    await fakeVitest(
      ' Test Files  1 failed | 1 passed (2)\n      Tests  3 failed | 14 passed (17)\nFAIL  tests/x.test.ts > thing\n  AssertionError: expected 1 to be 2\n',
      1,
    );
    const r = runRelatedTests(['src/foo.ts'], { projectRoot: root, env: {} });
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.testsRun).toBe(17);
    expect(r.failures).toBe(3);
    expect(r.summary).toMatch(/3 failed of 17/);
    expect(r.summary).toMatch(/FAIL\s+tests\/x\.test\.ts/);
  });

  it('quotes filenames defensively', async () => {
    // Filename with spaces must not blow up the shell command construction.
    await fakeVitest(' Test Files  0 passed (0)\n      Tests  0 passed (0)\n', 0);
    expect(() =>
      runRelatedTests(['src/has space.ts'], { projectRoot: root, env: {} }),
    ).not.toThrow();
  });

  it('falls back to exit-code summary when no failure count parses', async () => {
    await fakeVitest('something blew up before tests started\n', 7);
    const r = runRelatedTests(['src/foo.ts'], { projectRoot: root, env: {} });
    expect(r.passed).toBe(false);
    expect(r.summary).toMatch(/vitest exited 7/);
  });
});
