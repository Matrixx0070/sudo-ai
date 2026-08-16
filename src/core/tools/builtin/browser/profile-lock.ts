/**
 * @file profile-lock.ts
 * @description Chromium ProcessSingleton lock inspection for persistent
 * browser profiles.
 *
 * Chromium refuses to start on a userDataDir that another LIVE process holds:
 *   "Failed to create a ProcessSingleton for your profile directory."
 * That is fatal for every sudo-ai process except the one that got there first
 * — the daemon holds data/browser-profiles/default, so the TUI, the bench
 * runner, the eval sandbox and the local test suite all abort.
 *
 * The lock is a symlink `<profile>/SingletonLock -> <hostname>-<pid>`. This
 * module reads it and distinguishes the two cases that need OPPOSITE handling:
 *
 *   - STALE (owning pid gone): remove the Singleton* files and reuse the real
 *     profile — the cookies are ours and nobody is using them.
 *   - LIVE (owning pid alive): do NOT touch the profile. The caller forks to a
 *     per-process sibling dir `<profile>__pid<N>` instead of aborting.
 *
 * Forked dirs are throwaway (fresh cookie jar) and are removed on close; a
 * sweep also reaps dirs left behind by processes that died without closing.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createLogger } from '../../../shared/logger.js';
// The fork naming rule is OWNED by the registry: it must resolve `<base>__pid<N>`
// back to `<base>` so a derived name inherits every constraint (profile-registry.ts
// getProfileEntry). Defining it twice is how those two drift apart.
import { FORK_MARKER } from './profile-registry.js';

const log = createLogger('browser:profile-lock');

/** Files Chromium's ProcessSingleton creates in a userDataDir. */
const SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'] as const;

export interface LockOwner {
  /** Host recorded in the lock (Chromium writes `<hostname>-<pid>`). */
  host: string;
  /** Owning pid, or null when the lock target could not be parsed. */
  pid: number | null;
}

export type ProfileLockState =
  /** No lock present — launch straight against the profile. */
  | { state: 'free' }
  /** Lock owner is gone; the Singleton* files were removed. Launch normally. */
  | { state: 'stale-cleared'; owner: LockOwner }
  /** Lock owner is alive (or unverifiable). Do not touch this profile. */
  | { state: 'live'; owner: LockOwner };

/** True when `pid` names a running process (EPERM still means "alive"). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read `<dir>/SingletonLock`. Returns null when absent. A present-but-
 * unreadable lock yields `{ host: '', pid: null }` — unparseable is treated as
 * live by callers (never delete a lock we do not understand).
 */
export function readSingletonLock(dir: string): LockOwner | null {
  const lock = join(dir, 'SingletonLock');
  try {
    if (!lstatSync(lock).isSymbolicLink()) return { host: '', pid: null };
  } catch {
    return null; // ENOENT — no lock
  }
  let target: string;
  try {
    target = readlinkSync(lock);
  } catch {
    return { host: '', pid: null };
  }
  // `<hostname>-<pid>`; hostnames may contain '-', so split on the LAST one.
  const cut = target.lastIndexOf('-');
  if (cut <= 0) return { host: target, pid: null };
  const pid = Number(target.slice(cut + 1));
  return { host: target.slice(0, cut), pid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

/**
 * Classify (and, when stale, clear) the ProcessSingleton lock on `dir`.
 * Conservative by construction: a lock written by another HOST, or one whose
 * pid cannot be parsed, counts as live — we only ever delete a lock we can
 * positively prove is orphaned on this machine.
 */
export function inspectProfileLock(dir: string): ProfileLockState {
  const owner = readSingletonLock(dir);
  if (!owner) return { state: 'free' };

  const sameHost = owner.host === hostname();
  if (owner.pid === null || !sameHost || isProcessAlive(owner.pid)) {
    return { state: 'live', owner };
  }

  for (const f of SINGLETON_FILES) {
    try { rmSync(join(dir, f), { force: true }); } catch { /* best-effort */ }
  }
  return { state: 'stale-cleared', owner };
}

/** Sibling dir used when the real profile is held by another live process. */
export function forkedProfileDir(baseDir: string, pid: number = process.pid): string {
  return join(dirname(baseDir), `${basename(baseDir)}${FORK_MARKER}${pid}`);
}

/** Create (0700, like the real profile dirs) and return this process's fork. */
export function ensureForkedProfileDir(baseDir: string, pid: number = process.pid): string {
  const dir = forkedProfileDir(baseDir, pid);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  return dir;
}

/** True for a dir produced by {@link forkedProfileDir}. */
export function isForkedProfileDir(dir: string): boolean {
  return basename(dir).includes(FORK_MARKER);
}

/**
 * Remove per-process forks of `baseDir` whose owning process is gone (and any
 * fork owned by THIS process, which by definition is being re-created).
 * Bounds the fork dirs so a crash loop cannot fill the disk.
 * Returns the dirs removed.
 */
export function sweepForkedProfiles(baseDir: string): string[] {
  const parent = dirname(baseDir);
  const prefix = `${basename(baseDir)}${FORK_MARKER}`;
  const removed: string[] = [];
  let entries: string[];
  try { entries = readdirSync(parent); } catch { return removed; }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid !== process.pid && isProcessAlive(pid)) continue;
    const dir = join(parent, name);
    try { rmSync(dir, { recursive: true, force: true }); removed.push(dir); } catch { /* best-effort */ }
  }
  return removed;
}

/**
 * True when a launch failure is Chromium's ProcessSingleton abort. This is the
 * AUTHORITATIVE signal that another process holds the userDataDir — the
 * SingletonLock inspection is only advisory, because the file is written by
 * Chromium some milliseconds after it decides to start.
 */
export function isProcessSingletonAbort(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ProcessSingleton|SingletonLock: File exists/i.test(msg);
}

/** Thrown when the profile is held by a live process and forking is not allowed. */
export class ProfileLockedError extends Error {
  constructor(public readonly requestedDir: string, public readonly ownerPid: number | null) {
    super(
      `browser profile dir "${requestedDir}" is held by another live process` +
        (ownerPid === null ? '' : ` (pid ${ownerPid})`) +
        ' and forking is not permitted for this profile — close the other browser first',
    );
    this.name = 'ProfileLockedError';
  }
}

/**
 * Decide which userDataDir to actually launch on, given the profile dir the
 * caller asked for. Reaps dead forks, clears a stale lock, and forks only when
 * a live process holds the profile. Logs loudly — a silently different profile
 * means silently different cookies.
 *
 * @param allowFork false REFUSES rather than forking a live-locked profile.
 *        Callers pass false for owner-only profiles: a fork is a *new*
 *        userDataDir with a *new* identity, and a second on-disk home for an
 *        owner-only identity is a lateral surface with no upside (the fork has
 *        a fresh cookie jar, so it cannot do the thing the profile exists for).
 */
export function resolveLaunchProfileDir(
  requestedDir: string,
  opts: { allowFork?: boolean } = {},
): { dir: string; forked: boolean } {
  sweepForkedProfiles(requestedDir);
  const lock = inspectProfileLock(requestedDir);
  if (lock.state === 'stale-cleared') {
    log.warn({ requestedDir, staleOwnerPid: lock.owner.pid }, 'Cleared a stale ProcessSingleton lock on browser profile');
    return { dir: requestedDir, forked: false };
  }
  if (lock.state === 'free') return { dir: requestedDir, forked: false };
  if (opts.allowFork === false) {
    log.warn({ requestedDir, lockOwnerPid: lock.owner.pid }, 'Browser profile is locked by a live process and may not be forked — refusing');
    throw new ProfileLockedError(requestedDir, lock.owner.pid);
  }
  const dir = ensureForkedProfileDir(requestedDir);
  log.warn(
    { requestedDir, dir, lockOwnerPid: lock.owner.pid, pid: process.pid },
    "Browser profile is locked by another live process — using a PER-PROCESS FORK: fresh cookie jar, the requested profile's logins are NOT available here",
  );
  return { dir, forked: true };
}

/**
 * Launch a persistent context on `requestedDir`, surviving a collision with
 * another live process. `launch` is injected so this module stays free of any
 * Playwright import.
 *
 * Two defences, because one is not enough:
 *  1. {@link resolveLaunchProfileDir} inspects SingletonLock up front.
 *  2. That inspection is ADVISORY — between reading the lock and Chromium
 *     writing it there is a window in which a second process sees a free
 *     profile. Measured: three vitest workers cold-started on the same profile,
 *     all read "free", and one still died with the ProcessSingleton abort.
 *     Chromium's own failure is authoritative, so retry once on the fork.
 */
export async function launchWithLockFallback<T>(
  requestedDir: string,
  allowFork: boolean,
  launch: (dir: string) => Promise<T>,
  logCtx: Record<string, unknown> = {},
): Promise<{ value: T; dir: string; forked: boolean }> {
  const first = resolveLaunchProfileDir(requestedDir, { allowFork });
  log.info({ ...logCtx, requestedDir, userDataDir: first.dir, forked: first.forked }, 'Launching persistent browser profile');
  try {
    return { value: await launch(first.dir), dir: first.dir, forked: first.forked };
  } catch (err) {
    if (!isProcessSingletonAbort(err)) throw err;
    if (!allowFork) throw new ProfileLockedError(requestedDir, null);
    if (first.forked) throw err; // a fork of our own pid cannot be contended
    const dir = ensureForkedProfileDir(requestedDir);
    log.warn(
      { ...logCtx, requestedDir, dir, pid: process.pid },
      "Lost the ProcessSingleton race — retrying on a PER-PROCESS FORK: fresh cookie jar, the requested profile's logins are NOT available here",
    );
    return { value: await launch(dir), dir, forked: true };
  }
}

/** Remove a single forked profile dir. No-op for a non-forked path. */
export function removeForkedProfile(dir: string): boolean {
  if (!isForkedProfileDir(dir) || !existsSync(dir)) return false;
  try { rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}
