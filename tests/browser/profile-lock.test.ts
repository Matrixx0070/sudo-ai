/**
 * @file profile-lock.test.ts
 * @description Cross-PROCESS browser profile locking. The daemon holds
 * data/browser-profiles/default, so every OTHER process (TUI, bench runner,
 * eval sandbox, local test run) used to die with "Failed to create a
 * ProcessSingleton for your profile directory". These cover the decision table
 * that replaced that abort — pure fs, no browser needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync, statSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSingletonLock,
  isProcessAlive,
  inspectProfileLock,
  forkedProfileDir,
  ensureForkedProfileDir,
  isForkedProfileDir,
  sweepForkedProfiles,
  removeForkedProfile,
  resolveLaunchProfileDir,
} from '../../src/core/tools/builtin/browser/profile-lock.js';

let root: string;
let profile: string;

/** SingletonLock is a symlink to `<host>-<pid>` — a target that does not exist.
 *  existsSync FOLLOWS symlinks and would report false for every lock, so lock
 *  presence must be probed with lstat. */
function lockPresent(dir: string): boolean {
  try { return lstatSync(join(dir, 'SingletonLock')).isSymbolicLink(); } catch { return false; }
}

/** A pid that is certainly not running (high, unallocated). */
const DEAD_PID = 4_194_300;

function lock(dir: string, target: string): void {
  symlinkSync(target, join(dir, 'SingletonLock'));
  writeFileSync(join(dir, 'SingletonCookie'), 'x');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profile-lock-'));
  profile = join(root, 'default');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, 'Cookies'), 'real-login-data');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('readSingletonLock', () => {
  it('returns null when there is no lock', () => {
    expect(readSingletonLock(profile)).toBeNull();
  });

  it('parses <hostname>-<pid>, splitting on the LAST hyphen', () => {
    lock(profile, 'my-host-name-4242');
    expect(readSingletonLock(profile)).toEqual({ host: 'my-host-name', pid: 4242 });
  });

  it('reports pid null for a lock it cannot parse (never guessed)', () => {
    lock(profile, 'garbage');
    expect(readSingletonLock(profile)).toEqual({ host: 'garbage', pid: null });
  });
});

describe('isProcessAlive', () => {
  it('is true for this process and false for a dead pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
  });
});

describe('inspectProfileLock', () => {
  it('reports free when no lock exists', () => {
    expect(inspectProfileLock(profile)).toEqual({ state: 'free' });
  });

  it('reports live for a lock held by a running process and leaves it alone', () => {
    lock(profile, `${hostname()}-${process.pid}`);
    const res = inspectProfileLock(profile);
    expect(res.state).toBe('live');
    expect(lockPresent(profile)).toBe(true);
  });

  it('clears a STALE lock (owner gone) without touching profile data', () => {
    lock(profile, `${hostname()}-${DEAD_PID}`);
    const res = inspectProfileLock(profile);
    expect(res.state).toBe('stale-cleared');
    expect(lockPresent(profile)).toBe(false);
    expect(existsSync(join(profile, 'SingletonCookie'))).toBe(false);
    // The profile itself must survive — this is where the real logins live.
    expect(existsSync(join(profile, 'Cookies'))).toBe(true);
  });

  it('treats a foreign-host lock as live even if the pid is dead locally', () => {
    lock(profile, `some-other-box-${DEAD_PID}`);
    expect(inspectProfileLock(profile).state).toBe('live');
    expect(lockPresent(profile)).toBe(true);
  });

  it('treats an unparseable lock as live (never deletes what it cannot read)', () => {
    lock(profile, 'garbage');
    expect(inspectProfileLock(profile).state).toBe('live');
    expect(lockPresent(profile)).toBe(true);
  });
});

describe('resolveLaunchProfileDir', () => {
  it('uses the requested profile when it is unlocked', () => {
    expect(resolveLaunchProfileDir(profile)).toEqual({ dir: profile, forked: false });
  });

  it('uses the requested profile after clearing a stale lock (no fork)', () => {
    lock(profile, `${hostname()}-${DEAD_PID}`);
    expect(resolveLaunchProfileDir(profile)).toEqual({ dir: profile, forked: false });
    expect(existsSync(forkedProfileDir(profile))).toBe(false);
  });

  it('forks to a per-process dir (0700) when a live process holds the profile', () => {
    lock(profile, `${hostname()}-${process.pid}`);
    const res = resolveLaunchProfileDir(profile);
    expect(res.forked).toBe(true);
    expect(res.dir).toBe(join(root, `default__pid${process.pid}`));
    expect(existsSync(res.dir)).toBe(true);
    expect(statSync(res.dir).mode & 0o777).toBe(0o700);
    // The locked profile is left completely untouched.
    expect(lockPresent(profile)).toBe(true);
    expect(existsSync(join(profile, 'Cookies'))).toBe(true);
  });
});

describe('fork lifecycle (no unbounded accumulation)', () => {
  it('sweeps forks of dead processes and keeps forks of live ones', () => {
    const dead = join(root, `default__pid${DEAD_PID}`);
    const live = join(root, `default__pid${process.pid}`);
    const other = join(root, 'work__pid1');
    for (const d of [dead, live, other]) mkdirSync(d, { recursive: true });
    // Our own pid is swept too: a relaunch in this process re-creates it.
    const removed = sweepForkedProfiles(profile);
    expect(removed).toContain(dead);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(other)).toBe(true); // different base profile — untouched
    expect(existsSync(profile)).toBe(true);

    // A fork owned by another LIVE process survives the sweep.
    mkdirSync(live, { recursive: true });
    const alive = join(root, `default__pid${process.ppid}`);
    mkdirSync(alive, { recursive: true });
    sweepForkedProfiles(profile);
    expect(existsSync(alive)).toBe(true);
  });

  it('removeForkedProfile deletes a fork and refuses a real profile dir', () => {
    const fork = ensureForkedProfileDir(profile);
    expect(isForkedProfileDir(fork)).toBe(true);
    expect(isForkedProfileDir(profile)).toBe(false);
    expect(removeForkedProfile(fork)).toBe(true);
    expect(existsSync(fork)).toBe(false);
    expect(removeForkedProfile(profile)).toBe(false);
    expect(existsSync(profile)).toBe(true);
  });
});
