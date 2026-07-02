/**
 * P0 #7 — command-type hooks must not block the event loop.
 *
 * The bridge previously used execSync, freezing all of Node for up to the
 * hook timeout (default 30s) on every fire (e.g. before:tool-call). runHookCommand
 * uses async spawn: it resolves without blocking, feeds ctx to stdin, and
 * swallows failures (fire-and-forget) rather than throwing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { runHookCommand } from '../../src/core/plugins/plugin-hooks.js';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = () => ({ ...process.env } as Record<string, string>);
const tmpFiles: string[] = [];
function tmpFile(): string {
  const p = join(tmpdir(), `hooktest-${process.pid}-${tmpFiles.length}.txt`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles) { try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ } }
  tmpFiles.length = 0;
});

describe('runHookCommand (P0 #7)', () => {
  it('resolves on success without throwing', async () => {
    await expect(runHookCommand('ok', 'exit 0', env(), '', 5_000)).resolves.toBeUndefined();
  });

  it('swallows a non-zero exit (fire-and-forget, never rejects)', async () => {
    await expect(runHookCommand('fail', 'exit 3', env(), '', 5_000)).resolves.toBeUndefined();
  });

  it('swallows a spawn error for a non-existent command', async () => {
    await expect(
      runHookCommand('missing', '/no/such/binary/xyzzy', env(), '', 5_000),
    ).resolves.toBeUndefined();
  });

  it('delivers the context payload to the child stdin', async () => {
    const out = tmpFile();
    const payload = JSON.stringify({ event: 'before:tool-call', toolName: 'x' });
    await runHookCommand('cat', `cat > ${out}`, env(), payload, 5_000);
    expect(readFileSync(out, 'utf8')).toBe(payload);
  });

  it('does NOT block the event loop while the command runs', async () => {
    // A concurrent timer set to fire mid-command must actually fire before the
    // command resolves — impossible if the call blocked the loop (execSync did).
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 60);
    await runHookCommand('sleep', 'sleep 0.25', env(), '', 5_000);
    clearTimeout(timer);
    expect(timerFired).toBe(true);
  });

  it('kills a command that exceeds its timeout and still resolves', async () => {
    const start = Date.now();
    await runHookCommand('slow', 'sleep 5', env(), '', 150);
    // Resolved well before the 5s sleep would have finished.
    expect(Date.now() - start).toBeLessThan(3_000);
  });
});
