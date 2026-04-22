/**
 * @file cli/commands/status.ts
 * @description Status sub-command for the SUDO-AI CLI.
 *
 * Reports whether SUDO-AI is running by checking:
 *   1. Whether data/sudo-ai.pid exists and the PID is alive.
 *   2. Whether the HTTP health endpoint responds at localhost:HEALTH_PORT.
 */

import path from 'node:path';
import { readPid, isRunning } from '../pid.js';
import { checkHealth } from '../health.js';
import { HEALTH_PORT } from '../../core/shared/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PID_PATH_RELATIVE = path.join('data', 'sudo-ai.pid');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Print the current SUDO-AI status and return an appropriate exit code.
 *
 * @param projectRoot Absolute path to the project root.
 * @returns 0 if running, 1 if stopped or indeterminate.
 */
export async function runStatus(projectRoot: string): Promise<number> {
  const pidPath = path.join(projectRoot, PID_PATH_RELATIVE);
  const pid = readPid(pidPath);

  console.log('\n  SUDO-AI Status\n  ──────────────────────────────');

  // ── PID check ──────────────────────────────────────────────────────────────
  if (pid === null) {
    console.log('  PID file    : not found');
    console.log('  Process     : stopped');
  } else if (!isRunning(pid)) {
    console.log(`  PID file    : ${pid} (stale — process not alive)`);
    console.log('  Process     : stopped');
  } else {
    console.log(`  PID file    : ${pid}`);
    console.log('  Process     : running');
  }

  // ── HTTP health check ─────────────────────────────────────────────────────
  const health = await checkHealth(HEALTH_PORT);

  switch (health.status) {
    case 'running':
      console.log(`  API health  : OK (HTTP ${health.httpStatus ?? '?'})`);
      break;
    case 'stopped':
      console.log(`  API health  : unhealthy (HTTP ${health.httpStatus ?? '?'})`);
      break;
    case 'unreachable':
      console.log(`  API health  : unreachable — ${health.error ?? 'no details'}`);
      break;
  }

  console.log('  ──────────────────────────────\n');

  // Running if both PID alive and health endpoint is up.
  const processAlive = pid !== null && isRunning(pid);
  return processAlive ? 0 : 1;
}
