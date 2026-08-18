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
 * The actual vitest argv for the apply-time gate. buildTestArgs still validates
 * the target; this adds `--no-file-parallelism` (run files serially → low peak
 * memory). The target was already regex-validated upstream.
 */
export function buildTestSpawnArgs(target: string): string[] {
  return ['test', '--', '--no-file-parallelism', ...(target ? [target] : [])];
}

/**
 * Run the suite in a DETACHED child process group with a capped heap, async.
 * Detached + own group lets us kill the whole vitest tree on timeout without
 * cross-signalling the bot.
 */
export function runTestDetached(args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let out = '';
    const cap = (b: Buffer): void => { out += b.toString(); if (out.length > 200_000) out = out.slice(-200_000); };
    const child = spawn('npm', args, {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --max-old-space-size=1024`.trim() },
    });
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      resolve({ code: 124, output: `${out}\n[test run timed out after ${timeoutMs}ms — killed]` });
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : (signal ? 124 : 1), output: out });
    });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, output: `spawn failed: ${String(err)}` }); });
  });
}
