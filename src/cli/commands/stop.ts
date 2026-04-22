/**
 * @file cli/commands/stop.ts
 * @description Stop sub-command for the SUDO-AI CLI.
 *
 * Reads the PID from data/sudo-ai.pid, sends SIGTERM to the process,
 * waits up to 5 seconds for it to exit, then removes the PID file.
 */

import path from 'node:path';
import { readPid, removePid, isRunning } from '../pid.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PID_PATH_RELATIVE = path.join('data', 'sudo-ai.pid');
const WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 200;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send SIGTERM to the running SUDO-AI process and wait for it to exit.
 *
 * @param projectRoot Absolute path to the project root.
 * @returns Exit code: 0 on success, 1 if the process could not be stopped.
 */
export async function runStop(projectRoot: string): Promise<number> {
  const pidPath = path.join(projectRoot, PID_PATH_RELATIVE);
  const pid = readPid(pidPath);

  if (pid === null) {
    console.log('[stop] SUDO-AI is not running (no PID file found)');
    return 0;
  }

  if (!isRunning(pid)) {
    console.log(`[stop] Stale PID file (PID ${pid} not alive) — cleaning up`);
    removePid(pidPath);
    return 0;
  }

  console.log(`[stop] Sending SIGTERM to PID ${pid}...`);

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[stop] Failed to signal process: ${msg}`);
    return 1;
  }

  // Poll until the process exits or we time out.
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (!isRunning(pid)) {
      removePid(pidPath);
      console.log('[stop] SUDO-AI stopped successfully');
      return 0;
    }
  }

  // Process did not exit gracefully within the timeout.
  console.error(
    `[stop] Process ${pid} did not exit within ${WAIT_MS / 1000}s — ` +
    `send SIGKILL manually: kill -9 ${pid}`,
  );
  return 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
