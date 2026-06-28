/**
 * @file cli/pid.ts
 * @description PID file management for SUDO-AI daemon mode.
 *
 * Provides atomic read/write/remove operations on the PID file
 * located at data/sudo-ai.pid, and liveness checks via signal 0.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the parent directory of `pidPath` exists.
 * Creates it recursively if absent.
 */
function ensureDir(pidPath: string): void {
  const dir = path.dirname(pidPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write the current process PID to `pidPath`.
 * Overwrites any existing file.
 *
 * @throws {Error} if the directory cannot be created or the file cannot be written.
 */
export function writePid(pidPath: string): void {
  ensureDir(pidPath);
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
}

/**
 * Read the PID from `pidPath`.
 *
 * @returns The PID as a number, or null if the file does not exist or is invalid.
 */
export function readPid(pidPath: string): number | null {
  if (!fs.existsSync(pidPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(pidPath, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (Number.isNaN(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

/**
 * Remove the PID file at `pidPath`.
 * Safe to call even if the file does not exist.
 */
export function removePid(pidPath: string): void {
  try {
    fs.unlinkSync(pidPath);
  } catch (err: unknown) {
    // Ignore ENOENT — file already gone. Re-throw anything else.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Check whether a process with the given PID is currently alive.
 *
 * Uses signal 0 (no-op signal) to probe without sending an actual signal.
 *
 * @returns true if the process is running; false otherwise.
 */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // ESRCH = no such process (truly gone). EPERM = exists but owned by another
    // user — the process IS running; treat it as alive to avoid silently skipping
    // stop/restart.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
