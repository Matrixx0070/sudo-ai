/**
 * @file arsenal-v2/verify.ts
 * @description Run vitest --related against patch-touched files.
 *
 * Pairs with the existing tsc verify step in {@link ./index.ts}. After patches
 * land, we already re-run tsc to catch type regressions; this module adds the
 * second leg — running only the tests that statically depend on the changed
 * files. Scope is intentionally narrow: we don't run the whole suite (too slow
 * for the tool's 300s budget) and we don't fail-and-rollback on red (matches
 * how tsc is treated — a signal in the report, not a transaction abort).
 *
 * Skip conditions (the result.skipReason field):
 *   - no_files:        caller passed an empty changedFiles array
 *   - disabled_env:    SUDO_ARSENAL_V2_SKIP_TESTS=1 is set
 *   - binary_missing:  node_modules/.bin/vitest does not exist
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface VerifyOptions {
  projectRoot: string;
  /** Override for tests. Defaults to `<projectRoot>/node_modules/.bin/vitest`. */
  vitestBin?: string;
  /** Override for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override for tests. Defaults to 120_000ms. */
  timeoutMs?: number;
}

export interface VerifyResult {
  /** Whether vitest was actually invoked. */
  ran: boolean;
  /** True when ran=false; check skipReason for why. */
  skipped: boolean;
  skipReason?: 'no_files' | 'disabled_env' | 'binary_missing';
  /** True iff vitest exited 0. Always false when skipped. */
  passed: boolean;
  /** Best-effort parse of the "Tests X passed (N)" line. -1 when unknown. */
  testsRun: number;
  /** Best-effort parse of the "Tests Y failed" count. 0 when unknown / clean. */
  failures: number;
  /** Human-readable one-paragraph summary suitable for the tool report. */
  summary: string;
}

/**
 * Run `vitest --run --related <files> --passWithNoTests` against the project.
 * Returns a structured signal — never throws. The caller decides whether a
 * red result blocks tool success.
 */
export function runRelatedTests(changedFiles: string[], opts: VerifyOptions): VerifyResult {
  const env = opts.env ?? process.env;
  const vitestBin = opts.vitestBin ?? path.join(opts.projectRoot, 'node_modules', '.bin', 'vitest');
  const timeoutMs = opts.timeoutMs ?? 120_000;

  if (env['SUDO_ARSENAL_V2_SKIP_TESTS'] === '1') {
    return {
      ran: false,
      skipped: true,
      skipReason: 'disabled_env',
      passed: false,
      testsRun: 0,
      failures: 0,
      summary: 'Tests: skipped (SUDO_ARSENAL_V2_SKIP_TESTS=1)',
    };
  }

  if (changedFiles.length === 0) {
    return {
      ran: false,
      skipped: true,
      skipReason: 'no_files',
      passed: false,
      testsRun: 0,
      failures: 0,
      summary: 'Tests: skipped (no files changed)',
    };
  }

  if (!existsSync(vitestBin)) {
    return {
      ran: false,
      skipped: true,
      skipReason: 'binary_missing',
      passed: false,
      testsRun: 0,
      failures: 0,
      summary: `Tests: skipped (vitest not available at ${vitestBin})`,
    };
  }

  // Quote file args defensively — paths can contain spaces. --passWithNoTests
  // makes "no tests touch these files" a success rather than the default
  // exit-1 that vitest uses for "no test files found".
  const quoted = changedFiles.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(' ');
  const cmd = `"${vitestBin}" --run --related ${quoted} --passWithNoTests`;

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execSync(cmd, {
      cwd: opts.projectRoot,
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    exitCode = typeof e.status === 'number' ? e.status : 1;
  }

  const combined = `${stdout}\n${stderr}`;
  const { tests, failures } = parseVitestSummary(combined);
  const passed = exitCode === 0;

  let summary: string;
  if (passed) {
    summary = tests >= 0
      ? `Tests: ${tests} passed, 0 failed ✓`
      : 'Tests: clean ✓ (counts unavailable)';
  } else {
    const tail = combined
      .split('\n')
      .filter((l) => /FAIL|✗|×|Error:|AssertionError/.test(l))
      .slice(0, 10);
    const head = failures > 0
      ? `Tests: ${failures} failed${tests >= 0 ? ` of ${tests}` : ''} ⚠`
      : `Tests: vitest exited ${exitCode} ⚠`;
    summary = [head, ...tail].join('\n');
  }

  return {
    ran: true,
    skipped: false,
    passed,
    testsRun: tests,
    failures,
    summary,
  };
}

/**
 * Parse vitest's terminal summary block. Vitest prints e.g.
 *   `Test Files  1 failed | 4 passed (5)`
 *   `     Tests  2 failed | 40 passed (42)`
 * We only need the second line for the totals. Returns -1 / 0 when the
 * regex misses (e.g. when --passWithNoTests short-circuits with no summary).
 */
export function parseVitestSummary(output: string): { tests: number; failures: number } {
  // Strip ANSI color codes so the regex doesn't need to anticipate them.
  const clean = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  const failed = clean.match(/Tests\s+(\d+)\s+failed/);
  const passed = clean.match(/Tests\s+(?:\d+\s+failed\s*\|\s*)?(\d+)\s+passed\s*\((\d+)\)/);
  if (passed) {
    return { tests: Number(passed[2]), failures: failed ? Number(failed[1]) : 0 };
  }
  if (failed) {
    return { tests: -1, failures: Number(failed[1]) };
  }
  return { tests: -1, failures: 0 };
}
