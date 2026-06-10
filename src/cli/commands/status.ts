/**
 * @file cli/commands/status.ts
 * @description Status sub-command for the SUDO-AI CLI.
 *
 * Reports whether SUDO-AI is running by checking:
 *   1. Whether data/sudo-ai.pid exists and the PID is alive.
 *   2. Whether the HTTP health endpoint responds at localhost:HEALTH_PORT.
 */

import { readPid, isRunning } from '../pid.js';
import { checkHealth } from '../health.js';
import { HEALTH_PORT, PID_PATH } from '../../core/shared/constants.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Print the current SUDO-AI status and return an appropriate exit code.
 *
 * @returns 0 if running, 1 if stopped or indeterminate.
 */
export async function runStatus(): Promise<number> {
  const pidPath = PID_PATH;
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
