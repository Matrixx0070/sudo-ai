/**
 * Shared restart plumbing for the meta tools that bounce the live SUDO-AI
 * process (self-modify, service-control, self-update).
 *
 * The live deployment runs under pm2 as `sudo-ai-v5` (the `sudo-ai` systemd
 * unit is masked), so the default restart is the pm2 ecosystem-file form —
 * it also reloads the ecosystem env, so a restart can't silently drop new
 * env keys via a stale pm2 dump. `systemctl` remains the fallback for
 * deployments without pm2. Override everything with SUDO_RESTART_CMD.
 */

import { execSync, spawn } from 'node:child_process';
import { createLogger } from '../../../shared/logger.js';
import { PROJECT_ROOT } from '../../../shared/paths.js';

const logger = createLogger('meta.restart-helper');

const PM2_RESTART = 'pm2 restart ecosystem.config.cjs --only sudo-ai-v5 --update-env';
const SYSTEMCTL_RESTART = 'systemctl restart sudo-ai';

export function hasPm2(): boolean {
  try {
    execSync('command -v pm2', { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * The command that restarts the live SUDO-AI service. Exported for unit
 * testing; also re-exported from self-modify.ts for compatibility.
 */
export function restartCommand(): string {
  const override = process.env['SUDO_RESTART_CMD'];
  if (override && override.trim()) return override.trim();
  return PM2_RESTART;
}

export function resolveRestartCmd(): { cmd: string; via: 'override' | 'pm2' | 'systemctl' } {
  const override = process.env['SUDO_RESTART_CMD'];
  if (override && override.trim()) return { cmd: override.trim(), via: 'override' };
  if (hasPm2()) return { cmd: PM2_RESTART, via: 'pm2' };
  return { cmd: SYSTEMCTL_RESTART, via: 'systemctl' };
}

export interface ScheduledRestart {
  scheduled: boolean;
  cmd: string;
  error?: string;
}

/**
 * A self-restart kills THIS process, so the restart must outlive us: spawn a
 * DETACHED child that waits a few seconds (letting the tool's result flush to
 * the user) then restarts the service. Success cannot be confirmed
 * synchronously — by the time pm2 bounces us, this process is gone.
 */
export function scheduleDetachedRestart(reason: string, cwd: string = PROJECT_ROOT): ScheduledRestart {
  const { cmd, via } = resolveRestartCmd();
  logger.info({ cmd, via, reason }, 'Scheduling detached service restart');
  try {
    const child = spawn('sh', ['-c', `sleep 3; ${cmd}`], {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: process.env,
    });
    child.unref();
    return { scheduled: true, cmd };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ cmd, err: msg }, 'Failed to schedule restart');
    return { scheduled: false, cmd, error: msg };
  }
}
