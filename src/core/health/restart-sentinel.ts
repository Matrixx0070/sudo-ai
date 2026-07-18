/**
 * @file restart-sentinel.ts
 * @description GW-9 — verified restart handoff.
 *
 * SUDO restarts (updater merge→pull+restart, Kairos systemctl restart) are
 * fire-and-forget: there is no proof the successor came up before the
 * predecessor is gone. This module adds a sentinel-file protocol under
 * data/restart/ so a restart can be VERIFIED:
 *
 *   1. The initiator writes `intent.json` BEFORE triggering the restart.
 *   2. On boot, once the successor has finished init (gateway listening +
 *      SecurityGuard up + channels started) it writes `ready.json` and deletes
 *      `intent.json` (completeBootHandoff).
 *   3. An external initiator (updater script) that survives the restart polls
 *      for `ready.json` with a timeout (waitForReady) → timeout ⇒ alert.
 *   4. If a *stale* intent (> staleMs, default 10 min) is found at boot, the
 *      previous handoff is presumed FAILED — flagged in posture/telemetry and,
 *      for a Kairos-initiated restart, used to put Kairos into cooldown so it
 *      does not enter a restart loop.
 *
 * Systemd remains the process supervisor; the sentinel adds verification, not
 * lifecycle ownership. All functions are pure over an injected directory + clock
 * so the intent→ready lifecycle, staleness, and watchdog timeout are unit-testable.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  renameSync,
} from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createLogger } from '../shared/logger.js';

const log = createLogger('health:restart-sentinel');

/** 10 minutes: an intent older than this at boot means the handoff never completed. */
export const DEFAULT_STALE_MS = 600_000;
/** Watchdog default: how long an initiator waits for the successor's ready.json. */
export const DEFAULT_READY_TIMEOUT_MS = 120_000;

export interface RestartIntent {
  reason: string;
  /** Who asked for the restart: 'kairos' | 'updater' | 'admin-api' | 'manual' | … */
  initiator: string;
  /** ms epoch the intent was written. */
  ts: number;
  /** Short git sha of the predecessor, best-effort. */
  gitSha: string;
}

export interface RestartReady {
  /** ms epoch the successor finished boot. */
  bootTs: number;
  gitSha: string;
  port: number;
}

/** File layout under the restart dir. */
function intentPath(dir: string): string { return path.join(dir, 'intent.json'); }
function readyPath(dir: string): string { return path.join(dir, 'ready.json'); }

/** Resolve the sentinel dir (default DATA_DIR/restart, overridable for tests). */
export function restartDir(dataDir: string = process.env['DATA_DIR'] ?? 'data'): string {
  return path.join(dataDir, 'restart');
}

/** Best-effort short git sha; '' when git is unavailable (never throws). */
export function shortGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', timeout: 3_000 }).trim();
  } catch {
    return '';
  }
}

/** Atomic JSON write (tmp + rename) so a reader never sees a half-written file. */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    log.warn({ err: String(err), file }, 'restart-sentinel: unreadable sentinel file — treating as absent');
    return null;
  }
}

// --------------------------------------------------------------------------
// Intent (initiator side, written BEFORE the restart is triggered)
// --------------------------------------------------------------------------

/** Write intent.json BEFORE triggering a restart. Returns the record written. */
export function writeRestartIntent(
  dir: string,
  fields: { reason: string; initiator: string; gitSha?: string; now?: number },
): RestartIntent {
  const intent: RestartIntent = {
    reason: fields.reason,
    initiator: fields.initiator,
    ts: fields.now ?? Date.now(),
    gitSha: fields.gitSha ?? shortGitSha(),
  };
  writeJsonAtomic(intentPath(dir), intent);
  log.warn({ ...intent }, 'restart intent recorded (handoff will be verified)');
  return intent;
}

export function readRestartIntent(dir: string): RestartIntent | null {
  return readJson<RestartIntent>(intentPath(dir));
}

export function clearRestartIntent(dir: string): void {
  try { rmSync(intentPath(dir), { force: true }); } catch { /* best-effort */ }
}

export function readReady(dir: string): RestartReady | null {
  return readJson<RestartReady>(readyPath(dir));
}

export function clearReady(dir: string): void {
  try { rmSync(readyPath(dir), { force: true }); } catch { /* best-effort */ }
}

/** An intent is stale when it has outlived staleMs without a successful handoff. */
export function isStaleIntent(intent: RestartIntent, nowMs: number, staleMs = DEFAULT_STALE_MS): boolean {
  return nowMs - intent.ts > staleMs;
}

// --------------------------------------------------------------------------
// Boot side (successor)
// --------------------------------------------------------------------------

export interface BootHandoffResult {
  /** True when a restart intent was found — this boot resumes an intended restart. */
  resumed: boolean;
  /** The intent that triggered this boot, if any. */
  intent: RestartIntent | null;
  /** True when the intent was STALE (> staleMs) — a previous handoff likely failed. */
  staleHandoff: boolean;
}

/**
 * Called once the successor has finished init (gateway listening + guard up +
 * channels started). Reads any pending intent, writes ready.json, deletes the
 * intent, and reports whether the boot resumed an intended restart and whether
 * that intent was stale (a possibly-failed prior handoff).
 */
export function completeBootHandoff(
  dir: string,
  fields: { port: number; gitSha?: string; now?: number; staleMs?: number },
): BootHandoffResult {
  const now = fields.now ?? Date.now();
  const intent = readRestartIntent(dir);
  const staleHandoff = intent ? isStaleIntent(intent, now, fields.staleMs ?? DEFAULT_STALE_MS) : false;

  const ready: RestartReady = {
    bootTs: now,
    gitSha: fields.gitSha ?? shortGitSha(),
    port: fields.port,
  };
  writeJsonAtomic(readyPath(dir), ready);

  if (intent) {
    if (staleHandoff) {
      log.error(
        { intent, ageMs: now - intent.ts },
        'STALE restart intent at boot — the previous handoff likely FAILED (successor took too long / crash-looped)',
      );
    } else {
      log.info({ reason: intent.reason, initiator: intent.initiator }, 'resuming from intended restart');
    }
    clearRestartIntent(dir);
  }

  return { resumed: intent !== null, intent, staleHandoff };
}

// --------------------------------------------------------------------------
// Watchdog (external initiator that survives the restart, e.g. updater script)
// --------------------------------------------------------------------------

/**
 * Poll for a ready.json newer than `sinceMs` (the moment the initiator triggered
 * the restart) until timeout. Returns the ready record, or null on timeout.
 * Clock + sleep injected so the timeout path is testable without real time.
 */
export async function waitForReady(
  dir: string,
  opts: {
    sinceMs: number;
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<RestartReady | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? 1_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;

  for (;;) {
    const ready = readReady(dir);
    // Only accept a ready written AFTER we triggered the restart — a stale
    // ready.json from a prior boot must not be mistaken for the new successor.
    if (ready && ready.bootTs >= opts.sinceMs) return ready;
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}
