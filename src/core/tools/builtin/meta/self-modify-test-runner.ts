/**
 * @file self-modify-test-runner.ts
 * @description The apply-time test gate for meta.self-modify, split out to keep
 * self-modify.ts under the line ratchet.
 *
 * buildTestArgs validates the agent-supplied target (injection guard).
 * buildTestSpawnArgs adds the isolation flags. runTestDetached runs vitest in a
 * DETACHED child process group with a capped heap, ASYNC — so the suite never
 * freezes the bot's event loop (the old execFileSync did) and a heavy suite
 * can't OOM/signal-cross with the bot (which got it killed at exit 124).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../../../shared/paths.js';

/** A vitest target is a path or filename glob — reject anything with shell metacharacters. */
const TEST_TARGET_RE = /^[A-Za-z0-9_./*-]+$/;

/**
 * Build the `npm test` argument array for an optional, validated vitest target.
 * Exported for unit testing the injection guard without executing the suite.
 */
export function buildTestArgs(testTarget?: string): { args: string[] } | { error: string } {
  const target = (testTarget ?? '').trim();
  if (target && !TEST_TARGET_RE.test(target)) {
    return { error: `Invalid testTarget "${target}". Only letters, digits and . _ - / * are allowed (a vitest path or filename pattern).` };
  }
  // `npm test -- <target>` → `vitest run <target>`; no target → full suite.
  return { args: target ? ['test', '--', target] : ['test'] };
}

/**
 * The actual vitest argv for the apply-time gate. Targets are already
 * regex-validated upstream (buildTestArgs per target). Adds
 * `--no-file-parallelism` (run files serially → low peak memory). Multiple
 * targets run as multiple vitest positional filters; none → full suite.
 */
export function buildTestSpawnArgs(targets: string[]): string[] {
  const clean = targets.map((t) => t.trim()).filter(Boolean);
  return ['test', '--', '--no-file-parallelism', ...clean];
}

/**
 * Run the suite in a DETACHED child process group with a capped heap, async.
 * Detached + own group lets us kill the whole vitest tree on timeout without
 * cross-signalling the bot.
 *
 * ISOLATED DATA_DIR: the gate runs alongside the LIVE bot, which is concurrently
 * writing mind.db/traces.db/checkpoints.db under the real DATA_DIR. State-reading
 * tests (veto-gate, outcome-learner…) would see that churn and fail — not a
 * timing flake, so retry can't help. Pointing the run at a fresh temp DATA_DIR
 * makes those tests hermetic; the dir is removed when the run finishes.
 */
export function runTestDetached(args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let out = '';
    const cap = (b: Buffer): void => { out += b.toString(); if (out.length > 200_000) out = out.slice(-200_000); };

    let isoDataDir: string | null = null;
    try { isoDataDir = mkdtempSync(path.join(tmpdir(), 'sudo-apply-gate-')); } catch { /* fall back to inherited DATA_DIR */ }
    const cleanup = (): void => {
      if (!isoDataDir) return;
      try { rmSync(isoDataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      isoDataDir = null;
    };
    const done = (result: { code: number; output: string }): void => { cleanup(); resolve(result); };

    const child = spawn('npm', args, {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(isoDataDir ? { DATA_DIR: isoDataDir } : {}),
        NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --max-old-space-size=1024`.trim(),
      },
    });
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      done({ code: 124, output: `${out}\n[test run timed out after ${timeoutMs}ms — killed]` });
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code: typeof code === 'number' ? code : (signal ? 124 : 1), output: out });
    });
    child.on('error', (err) => { clearTimeout(timer); done({ code: 1, output: `spawn failed: ${String(err)}` }); });
  });
}
