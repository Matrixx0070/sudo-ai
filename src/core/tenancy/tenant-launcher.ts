/**
 * @file tenancy/tenant-launcher.ts
 * @description Default TenantLauncher — spawns a real SUDO-AI instance per tenant.
 *
 * Each tenant runs the same daemon entry (`node --import tsx src/cli.ts`) but with
 * cwd = the tenant home (whose src/config/node_modules are symlinks to the shared
 * code) and the tenant's isolation env. Detached + unref'd so the control plane
 * isn't the parent of every instance. Exercised by integration, not unit tests
 * (unit tests inject a mock launcher).
 */

import { spawn } from 'node:child_process';
import { createLogger } from '../shared/logger.js';
import type { Tenant, TenantLauncher } from './types.js';

const log = createLogger('tenancy:launcher');

/** Real child-process launcher: `node --import tsx src/cli.ts` in the tenant home. */
export const defaultTenantLauncher: TenantLauncher = {
  spawn(tenant: Tenant, env: NodeJS.ProcessEnv): Promise<number> {
    const child = spawn('node', ['--import', 'tsx', 'src/cli.ts'], {
      cwd: tenant.home,
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) {
      return Promise.reject(new Error(`tenant ${tenant.id}: spawn returned no pid`));
    }
    log.info({ tenantId: tenant.id, pid, port: tenant.port }, 'tenant instance spawned');
    return Promise.resolve(pid);
  },

  stop(pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      // Already dead / no such process — treat stop as idempotent.
      log.debug({ pid, err: String(err) }, 'stop: process not killable (likely already exited)');
    }
    return Promise.resolve();
  },

  isAlive(pid: number): boolean {
    try {
      // Signal 0 probes existence without delivering a signal.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
};
