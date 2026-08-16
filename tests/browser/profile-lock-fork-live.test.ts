/**
 * @file profile-lock-fork-live.test.ts
 * @description A SECOND process must get a working browser instead of a
 * ProcessSingleton abort when another live process already holds the profile
 * dir. The lock is planted with a real live pid (a spawned `sleep`), which is
 * exactly what Chromium writes, so this reproduces the daemon situation
 * without needing the daemon.
 *
 * ISOLATION: DATA_DIR is redirected to a fresh tmpdir BEFORE any module that
 * reads it is imported, so nothing here can touch a real profile dir under
 * data/browser-profiles (those hold live logins). Only the read-only
 * config/browser-profiles.json5 comes from the repo.
 *
 * The browser part skips when Chromium is absent (CI installs no browsers);
 * the constraint-inheritance part is pure and always runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserAvailable } from './_browser-available.js';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'fork-live-data-'));
process.env['DATA_DIR'] = DATA_ROOT;

// Imported AFTER DATA_DIR is set — paths.ts captures it at module load.
const { BrowserManager } = await import('../../src/core/tools/builtin/browser/browser-manager.js');
const { ensureProfileDir } = await import('../../src/core/tools/builtin/browser/profile-registry.js');
const { forkedProfileDir, inspectProfileLock } = await import(
  '../../src/core/tools/builtin/browser/profile-lock.js'
);

let holder: ChildProcess;

/** Plant a Chromium ProcessSingleton lock owned by the live `holder` process. */
function plantLiveLock(profileName: string): string {
  const dir = ensureProfileDir(profileName);
  const state = inspectProfileLock(dir); // also clears a stale lock
  if (state.state === 'live') {
    throw new Error(`profile "${profileName}" is in use (pid ${state.owner.pid}) — test needs an idle profile`);
  }
  symlinkSync(`${hostname()}-${holder.pid}`, join(dir, 'SingletonLock'));
  return dir;
}

beforeAll(() => {
  holder = spawn('sleep', ['300'], { stdio: 'ignore' });
});
afterAll(() => {
  holder.kill('SIGKILL');
  rmSync(DATA_ROOT, { recursive: true, force: true });
});

describe('a profile locked by another live process', () => {
  it('refuses a cold open of an owner-only profile before any dir work', async () => {
    await expect(
      BrowserManager.getInstance().launch('personal', true, false, false),
    ).rejects.toThrow(/owner-only/);
  });

  it('REFUSES to fork an owner-only profile even on the gated path', async () => {
    const dir = plantLiveLock('personal'); // registry: ownerOnly, trust high
    try {
      // allowOwnerOnly=true → past the identity gate, and still refused: a fork
      // would be a second on-disk home for a guarded identity, with a fresh
      // cookie jar that cannot do what the profile exists for.
      await expect(
        BrowserManager.getInstance().launch('personal', true, false, true),
      ).rejects.toThrow(/held by another live process/);
      expect(existsSync(forkedProfileDir(dir))).toBe(false);
    } finally {
      rmSync(join(dir, 'SingletonLock'), { force: true });
    }
  });

  it('refuses a fork DIR name supplied directly by a caller', async () => {
    await expect(
      BrowserManager.getInstance().launch(`personal__pid${process.pid}`, true, false, true),
    ).rejects.toThrow(/per-process fork/);
  });
});

describe.skipIf(!browserAvailable())('second process launch (real browser)', () => {
  it('gets a working browser on a per-process fork, then cleans it up', async () => {
    const dir = plantLiveLock('work'); // registry: trust medium, not ownerOnly
    const fork = forkedProfileDir(dir);
    // A leftover from an earlier run would mask the "created on demand" claim.
    rmSync(fork, { recursive: true, force: true });
    try {
      const inst = await BrowserManager.getInstance().launch('work', true);
      expect(inst.forked).toBe(true);
      expect(inst.profileDir).toBe(fork);
      // Registry metadata comes from the LOGICAL profile, not the fork dir.
      expect(inst.trust).toBe('medium');
      expect(inst.ownerOnly).toBe(false);
      // ...and it is a genuinely usable browser, not just an object.
      const page = await inst.context.newPage();
      await page.setContent('<h1 id="t">forked</h1>', { waitUntil: 'load' });
      expect(await page.textContent('#t')).toBe('forked');

      await BrowserManager.getInstance().close('work');
      expect(existsSync(fork)).toBe(false); // forks do not accumulate
      // The locked profile was never touched.
      expect(lstatSync(join(dir, 'SingletonLock')).isSymbolicLink()).toBe(true);
    } finally {
      await BrowserManager.getInstance().close('work').catch(() => {});
      rmSync(join(dir, 'SingletonLock'), { force: true });
      rmSync(fork, { recursive: true, force: true });
    }
  }, 60_000);

  it('reuses the real profile when the lock is stale (owner gone)', async () => {
    const dead = spawn('sleep', ['0'], { stdio: 'ignore' });
    const deadPid = dead.pid!;
    await new Promise((r) => dead.on('exit', r));
    const dir = ensureProfileDir('locktest');
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, 'SingletonLock'), { force: true });
    symlinkSync(`${hostname()}-${deadPid}`, join(dir, 'SingletonLock'));
    try {
      const inst = await BrowserManager.getInstance().launch('locktest', true);
      expect(inst.forked).toBe(false);
      expect(inst.profileDir).toBe(dir);
      expect(existsSync(forkedProfileDir(dir))).toBe(false);
    } finally {
      await BrowserManager.getInstance().close('locktest').catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
