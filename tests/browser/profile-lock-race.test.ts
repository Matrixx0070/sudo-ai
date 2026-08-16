/**
 * @file profile-lock-race.test.ts
 * @description The SingletonLock inspection is advisory, so it cannot be the
 * only defence.
 *
 * Measured on this branch: running the four live-browser suites together, three
 * vitest workers cold-started on data/browser-profiles/default at the same
 * moment; each read SingletonLock before any of them had written it, all three
 * saw "free", and one still died with
 *
 *   browserType.launchPersistentContext: Failed to create a ProcessSingleton
 *   for your profile directory.
 *
 * Chromium's own abort is the authoritative signal, so `launch` retries once on
 * a per-process fork. This suite drives N genuinely concurrent processes at one
 * profile — the shape that produced the failure — and requires every one of
 * them to come back with a working browser.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { browserAvailable } from './_browser-available.js';
import { isProcessSingletonAbort } from '../../src/core/tools/builtin/browser/profile-lock.js';

const execFileAsync = promisify(execFile);
const REPO = join(import.meta.dirname, '..', '..');
const WORKERS = 4;

describe('isProcessSingletonAbort', () => {
  it('matches the verbatim Playwright/Chromium abort (positive control)', () => {
    expect(isProcessSingletonAbort(new Error(
      'browserType.launchPersistentContext: Failed to create a ProcessSingleton for your ' +
      'profile directory. This usually means that the profile is already in use by another ' +
      'instance of Chromium.',
    ))).toBe(true);
    expect(isProcessSingletonAbort(new Error(
      'Failed to create /data/browser-profiles/default/SingletonLock: File exists (17)',
    ))).toBe(true);
  });

  it('does not match unrelated launch failures', () => {
    expect(isProcessSingletonAbort(new Error('Missing X server or $DISPLAY'))).toBe(false);
    expect(isProcessSingletonAbort(new Error('Executable doesn\'t exist'))).toBe(false);
  });
});

const dataRoot = mkdtempSync(join(tmpdir(), 'lock-race-data-'));
afterAll(() => rmSync(dataRoot, { recursive: true, force: true }));

describe.skipIf(!browserAvailable())('concurrent cold starts on one profile', () => {
  it(`gives all ${WORKERS} processes a working browser, never a ProcessSingleton abort`, async () => {
    // Each worker is a SEPARATE OS process, so none can see the others'
    // in-memory instance map — the exact condition the fix exists for.
    const script = join(dataRoot, 'worker.mts');
    writeFileSync(script, `
import { BrowserManager } from '${join(REPO, 'src/core/tools/builtin/browser/browser-manager.ts')}';
const m = BrowserManager.getInstance();
const inst = await m.launch('raceprofile', true);
const page = await inst.context.newPage();
await page.setContent('<b id=t>ok</b>');
const txt = await page.textContent('#t');
await m.close('raceprofile');
// Sentinel-delimited: the logger also writes to stdout.
process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ txt, forked: inst.forked === true, dir: inst.profileDir }) + '@@END@@\\n');
`);

    const results = await Promise.all(
      Array.from({ length: WORKERS }, () =>
        execFileAsync('npx', ['tsx', script], {
          cwd: REPO,
          env: { ...process.env, DATA_DIR: dataRoot },
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
        }),
      ),
    );

    const parsed = results.map((r) => {
      const m = /@@RESULT@@(.*)@@END@@/.exec(r.stdout);
      if (!m) throw new Error(`worker produced no result marker:\n${r.stdout}\n${r.stderr}`);
      return JSON.parse(m[1]!) as { txt: string; forked: boolean; dir: string };
    });
    expect(parsed).toHaveLength(WORKERS);
    for (const p of parsed) expect(p.txt).toBe('ok'); // a real, usable browser
    // NOT asserted: that all four dirs differ. A worker that finishes before a
    // later one starts legitimately hands the base profile back — measured, and
    // it is correct behaviour, not a collision.
    //
    // Forks were cleaned up on close — none may survive.
    const leftovers = readdirSync(join(dataRoot, 'browser-profiles')).filter((n) => n.includes('__pid'));
    expect(leftovers).toEqual([]);
  }, 180_000);
});
