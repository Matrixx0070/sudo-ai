/**
 * @file tenancy/types.ts
 * @description Data model for instance-per-tenant multi-tenancy (Stage 1).
 *
 * A "tenant" is an isolated SUDO-AI instance: its own home dir (own DATA_DIR +
 * WORKSPACE_DIR / vault / memory / sessions), its own GATEWAY_PORT + GATEWAY_TOKEN,
 * and a REQUIRED per-instance daily budget cap. The read-only code (src/, config/,
 * node_modules) is shared via symlinks, so isolation is filesystem-level without
 * retrofitting tenantId into the single-owner core.
 */

/** Lifecycle state of a tenant instance. */
export type TenantStatus = 'provisioned' | 'starting' | 'running' | 'stopped' | 'error';

/** A provisioned tenant instance and its isolation parameters. */
export interface Tenant {
  /** Filesystem-safe stable id (slug of name + random suffix). */
  id: string;
  /** Human label. */
  name: string;
  /** Absolute tenant home dir (== SUDO_AI_HOME for the instance). */
  home: string;
  /** Allocated GATEWAY_PORT for this instance. */
  port: number;
  /** Per-tenant INTERNAL GATEWAY_TOKEN (random, secret). The instance authenticates
   *  with this; the front-door injects it on upstream requests. NEVER given to the user. */
  token: string;
  /** Per-tenant PUBLIC credential the user presents at the front-door (random, secret,
   *  distinct from `token`). The front-door maps userKey → tenant, then proxies with `token`. */
  userKey: string;
  /** Per-instance hard daily budget cap (USD). REQUIRED — public tenants must be capped. */
  dailyBudgetUsd: number;
  /** Lifecycle status. */
  status: TenantStatus;
  /** OS pid when running, else null. */
  pid: number | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** Inputs to TenantManager.createTenant. */
export interface CreateTenantOptions {
  name: string;
  /** Hard daily cap in USD. Must be a finite number > 0 (and <= the manager's max). */
  dailyBudgetUsd: number;
}

/**
 * Injectable process launcher so the control-plane logic is unit-testable without
 * spawning real OS processes. The default implementation spawns the daemon
 * (`node --import tsx src/cli.ts`) with the tenant's env; tests inject a mock.
 */
export interface TenantLauncher {
  /** Spawn the instance with the given env; resolve to its pid. */
  spawn(tenant: Tenant, env: NodeJS.ProcessEnv): Promise<number>;
  /** Terminate the instance (SIGTERM). */
  stop(pid: number): Promise<void>;
  /** Whether the pid is currently alive. */
  isAlive(pid: number): boolean;
}
