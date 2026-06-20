/**
 * @file process-registry.ts
 * @description In-process registry for background shells (gap #10).
 *
 * Holds the live ChildProcess handles started by system.shell.start, buffers
 * their stdout/stderr in fixed-size byte ring buffers (drop-oldest on overflow),
 * and serves incremental polls via a monotonic byte cursor. Caps concurrency and
 * per-stream memory; reaps exited handles after a TTL via a single .unref()'d
 * interval (so it never holds the daemon open).
 *
 * Lifecycle: killSession() on per-session terminal events and killAll() on daemon
 * shutdown are wired in cli.ts (both gated by SUDO_BG_SHELL=1).
 */

import type { ChildProcess } from 'node:child_process';
import { createLogger } from '../../../../shared/logger.js';

const log = createLogger('system.bg-shell:registry');

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Max concurrent RUNNING shells (anti-fork-bomb). */
export const MAX_CONCURRENT = intEnv('SUDO_BG_SHELL_MAX_CONCURRENT', 8);
/** Per-stream ring-buffer byte cap. */
export const BUFFER_BYTES = intEnv('SUDO_BG_SHELL_BUFFER_BYTES', 256 * 1024);
/** Grace before SIGKILL after SIGTERM. */
const KILL_GRACE_MS = 3_000;
/** Reaper sweep interval + how long an exited handle stays pollable. */
const REAP_INTERVAL_MS = 30_000;
const REAP_TTL_MS = 5 * 60_000;

export type ShellStatus = 'running' | 'exited' | 'killed';

/** Fixed-byte-cap ring buffer with a monotonic total-byte cursor. */
export class RingBuffer {
  private buf: Buffer = Buffer.alloc(0);
  /** Total bytes ever appended (monotonic; the cursor space). */
  total = 0;
  /** Bytes dropped from the front due to the cap. */
  dropped = 0;

  constructor(private readonly cap: number) {}

  append(data: Buffer): void {
    this.total += data.length;
    this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
    if (this.buf.length > this.cap) {
      const drop = this.buf.length - this.cap;
      this.buf = this.buf.subarray(drop);
      this.dropped += drop;
    }
  }

  /** Bytes from `cursor` (a `total` offset) to now; clamps to what survives the cap. */
  readFrom(cursor: number): { text: string; missed: number } {
    const available = this.total - this.buf.length; // earliest cursor still buffered
    const from = Math.max(cursor, available);
    const missed = Math.max(0, available - cursor);
    const slice = this.buf.subarray(from - available);
    return { text: slice.toString('utf8'), missed };
  }
}

export interface ShellHandle {
  shellId: string;
  sessionId: string;
  command: string;
  child: ChildProcess;
  /** Process-group id for the raw (Branch A, detached) path; null for bwrap. */
  pgid: number | null;
  sandboxed: boolean;
  startedAt: number;
  exitedAt: number | null;
  status: ShellStatus;
  exitCode: number | null;
  stdout: RingBuffer;
  stderr: RingBuffer;
  /** Server-tracked read cursors so poll() returns only output since the last poll. */
  readCursorStdout: number;
  readCursorStderr: number;
}

const handles = new Map<string, ShellHandle>();
let reaper: ReturnType<typeof setInterval> | null = null;
/** In-flight reservations (a start that passed the cap but hasn't track()'d yet). */
let reserved = 0;

function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, h] of handles) {
      if (h.status !== 'running' && h.exitedAt !== null && now - h.exitedAt > REAP_TTL_MS) {
        handles.delete(id);
      }
    }
  }, REAP_INTERVAL_MS);
  // Never keep the daemon alive just for the reaper.
  reaper.unref();
}

/** Count of currently-running shells (for the concurrency cap). */
export function runningCount(): number {
  let n = 0;
  for (const h of handles.values()) if (h.status === 'running') n++;
  return n;
}

/**
 * Atomically reserve a slot against the concurrency cap, counting both running
 * shells AND in-flight reservations (a start awaiting approval). Closes the
 * TOCTOU where many concurrent starts pass a plain runningCount() check during
 * the approval wait and all spawn. Caller MUST release() on every exit path.
 */
export function tryReserve(): boolean {
  if (runningCount() + reserved >= MAX_CONCURRENT) return false;
  reserved++;
  return true;
}

/** Release a reservation taken by tryReserve(). */
export function release(): void {
  if (reserved > 0) reserved--;
}

/**
 * Wire a freshly-spawned child into a tracked handle. Must be called ONLY after
 * the command passed the approval gate AND spawn succeeded (never optimistically).
 */
export function track(args: {
  shellId: string;
  sessionId: string;
  command: string;
  child: ChildProcess;
  pgid: number | null;
  sandboxed: boolean;
}): ShellHandle {
  const handle: ShellHandle = {
    ...args,
    startedAt: Date.now(),
    exitedAt: null,
    status: 'running',
    exitCode: null,
    stdout: new RingBuffer(BUFFER_BYTES),
    stderr: new RingBuffer(BUFFER_BYTES),
    readCursorStdout: 0,
    readCursorStderr: 0,
  };
  args.child.stdout?.on('data', (d: Buffer) => handle.stdout.append(d));
  args.child.stderr?.on('data', (d: Buffer) => handle.stderr.append(d));
  const onEnd = (code: number | null): void => {
    if (handle.status === 'running') {
      handle.status = 'exited';
      handle.exitCode = code;
    }
    if (handle.exitedAt === null) handle.exitedAt = Date.now();
  };
  args.child.on('exit', onEnd);
  args.child.on('error', (err) => {
    log.warn({ shellId: args.shellId, err: err.message }, 'bg shell child error');
    onEnd(handle.exitCode);
  });
  handles.set(args.shellId, handle);
  ensureReaper();
  return handle;
}

export function get(shellId: string): ShellHandle | undefined {
  return handles.get(shellId);
}

/** Read output since the last poll and advance the read cursors. */
export function readNew(handle: ShellHandle): { stdout: string; stderr: string; missed: number } {
  const so = handle.stdout.readFrom(handle.readCursorStdout);
  const se = handle.stderr.readFrom(handle.readCursorStderr);
  handle.readCursorStdout = handle.stdout.total;
  handle.readCursorStderr = handle.stderr.total;
  return { stdout: so.text, stderr: se.text, missed: so.missed + se.missed };
}

/** SIGTERM then SIGKILL-after-grace the handle (whole tree). Idempotent. */
export function kill(handle: ShellHandle): void {
  if (handle.status !== 'running') return;
  handle.status = 'killed';
  if (handle.exitedAt === null) handle.exitedAt = Date.now();
  const send = (sig: NodeJS.Signals): void => {
    try {
      if (handle.pgid !== null) process.kill(-handle.pgid, sig); // raw detached: kill the group
      else handle.child.kill(sig); // bwrap PID-1: --die-with-parent reaps the inner tree
    } catch { /* already gone */ }
  };
  send('SIGTERM');
  const t = setTimeout(() => send('SIGKILL'), KILL_GRACE_MS);
  t.unref();
}

/** Kill every shell owned by a session (per-session terminal). */
export function killSession(sessionId: string): number {
  let n = 0;
  for (const h of handles.values()) {
    if (h.sessionId === sessionId && h.status === 'running') { kill(h); n++; }
  }
  return n;
}

/** Kill all shells (daemon shutdown). */
export function killAll(): number {
  let n = 0;
  for (const h of handles.values()) {
    if (h.status === 'running') { kill(h); n++; }
  }
  return n;
}

/** Test-only: clear the singleton + stop the reaper. */
export function _resetForTest(): void {
  for (const h of handles.values()) {
    try { if (h.status === 'running') h.child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  handles.clear();
  reserved = 0;
  if (reaper) { clearInterval(reaper); reaper = null; }
}
