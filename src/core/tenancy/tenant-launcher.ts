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

/**
 * Why this launcher refuses to run by default: it spawns each tenant as the
 * SAME OS user as the control plane, with no uid/gid drop and no sandbox — so a
 * tenant's own agent (which has shell/file tools) can read every OTHER tenant's
 * secrets (the 0o600 registry.json is meaningless same-UID) and data. That is
 * not a real isolation boundary. Real isolation (per-user provisioning or a
 * bubblewrap-wrapped instance) is a separate, unbuilt project.
 *
 * Fail-closed: inject a properly-isolating TenantLauncher, or set
 * SUDO_TENANCY_ALLOW_UNSAFE=1 to explicitly accept NO isolation (only sane when
 * every tenant is fully trusted — e.g. local dev).
 */
const UNSAFE_ISOLATION_MESSAGE =
  'the default launcher spawns tenants as the same OS user with no sandbox, so ' +
  "a tenant can read other tenants' secrets and data. Inject an isolating " +
  'TenantLauncher, or set SUDO_TENANCY_ALLOW_UNSAFE=1 to accept no isolation.';

/** Real child-process launcher: `node --import tsx src/cli.ts` in the tenant home. */
export const defaultTenantLauncher: TenantLauncher = {
  spawn(tenant: Tenant, env: NodeJS.ProcessEnv): Promise<number> {
    if (process.env['SUDO_TENANCY_ALLOW_UNSAFE'] !== '1') {
      return Promise.reject(new Error(
        `tenant ${tenant.id}: refusing to spawn — ${UNSAFE_ISOLATION_MESSAGE}`,
      ));
    }
    log.warn(
      { tenantId: tenant.id },
      'SUDO_TENANCY_ALLOW_UNSAFE=1 — spawning tenant with NO OS isolation (same user). Only safe when all tenants are fully trusted.',
    );
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
