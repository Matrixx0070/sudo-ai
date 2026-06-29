/**
 * @file tenancy/tenant-manager.ts
 * @description Stage 1 control plane for instance-per-tenant multi-tenancy.
 *
 * Provisions an isolated per-tenant home (own DATA_DIR + WORKSPACE_DIR/vault/memory,
 * shared read-only code via symlinks), allocates a free port + per-tenant
 * GATEWAY_TOKEN, REQUIRES a per-instance daily budget cap, and manages lifecycle
 * (start/stop/remove) through an injectable launcher. The tenant registry is an
 * atomically-written, 0o600 JSON file (it holds the per-tenant tokens).
 *
 * NOT wired into the running daemon — this is a self-contained library. Stage 2
 * adds the front-door auth + routing that fronts these instances.
 */

import {
  existsSync, mkdirSync, symlinkSync, rmSync, lstatSync,
  readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, chmodSync,
} from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import { defaultTenantLauncher } from './tenant-launcher.js';
import type { Tenant, CreateTenantOptions, TenantLauncher } from './types.js';

const log = createLogger('tenancy:manager');

/** Shared read-only code entries symlinked from sharedCodeRoot into each tenant home. */
const SHARED_CODE_ENTRIES = ['src', 'config', 'node_modules', 'package.json', 'tsconfig.json'] as const;

/**
 * Host env keys passed through to a tenant instance. Provider keys + the minimal
 * runtime keys only — NOT the host's full env (which carries the host's own
 * GATEWAY_TOKEN, DATA_DIR, SUDO_DAILY_BUDGET_USD='off', etc. that we must override).
 */
const ENV_PASSTHROUGH = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ',
  'XAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
] as const;
/** Prefixes whose keys also pass through (e.g. NODE_OPTIONS, NODE_ENV). */
const ENV_PASSTHROUGH_PREFIXES = ['NODE_'] as const;

const DEFAULT_PORT_RANGE: [number, number] = [19000, 19999];
const MAX_DAILY_BUDGET_USD = 1000;
const MAX_NAME_LEN = 64;
const TOKEN_BYTES = 24; // base64url → 32 chars

export interface TenantManagerOptions {
  /** Dir holding the registry + every tenant home. Created if missing. */
  controlPlaneDir: string;
  /** Dir containing the shared read-only code (must contain src/). */
  sharedCodeRoot: string;
  /** Inclusive [min,max] port range for instances. */
  portRange?: [number, number];
  /** Process launcher (injected in tests). */
  launcher?: TenantLauncher;
}

/** Provisions and manages isolated per-tenant SUDO-AI instances. */
export class TenantManager {
  private readonly controlPlaneDir: string;
  private readonly sharedCodeRoot: string;
  private readonly portRange: [number, number];
  private readonly launcher: TenantLauncher;
  private readonly registryFile: string;
  private tenants: Tenant[] = [];

  constructor(opts: TenantManagerOptions) {
    this.controlPlaneDir = path.resolve(opts.controlPlaneDir);
    this.sharedCodeRoot = path.resolve(opts.sharedCodeRoot);
    this.portRange = opts.portRange ?? DEFAULT_PORT_RANGE;
    this.launcher = opts.launcher ?? defaultTenantLauncher;
    this.registryFile = path.join(this.controlPlaneDir, 'registry.json');
    mkdirSync(this.controlPlaneDir, { recursive: true });
    this._loadRegistry();
    log.info({ controlPlaneDir: this.controlPlaneDir, tenants: this.tenants.length }, 'TenantManager initialized');
  }

  // -------------------------------------------------------------------------
  // Provisioning
  // -------------------------------------------------------------------------

  /** Provision a new isolated tenant (does NOT start it — call start(id)). */
  createTenant(opts: CreateTenantOptions): Tenant {
    const name = typeof opts?.name === 'string' ? opts.name.trim() : '';
    if (!name || name.length > MAX_NAME_LEN) {
      throw new Error(`createTenant: name must be a non-empty string <= ${MAX_NAME_LEN} chars`);
    }
    const budget = opts?.dailyBudgetUsd;
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0 || budget > MAX_DAILY_BUDGET_USD) {
      // Public tenants MUST be capped — a missing/<=0 budget is rejected by design.
      throw new Error(`createTenant: dailyBudgetUsd must be a finite number in (0, ${MAX_DAILY_BUDGET_USD}]`);
    }

    const id = this._allocateId(name);
    const port = this._allocatePort();
    // Two independent secrets: `token` is the INTERNAL instance credential (never
    // leaves the host); `userKey` is the PUBLIC credential the user presents at the
    // front-door. Keeping them distinct lets us rotate user access without restarting
    // the instance, and means a leaked userKey never equals the instance token.
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const userKey = randomBytes(TOKEN_BYTES).toString('base64url');
    const home = path.join(this.controlPlaneDir, id);

    this._provisionHome(home);

    const tenant: Tenant = {
      id, name, home, port, token, userKey,
      dailyBudgetUsd: budget,
      status: 'provisioned',
      pid: null,
      createdAt: new Date().toISOString(),
    };
    this.tenants.push(tenant);
    this._saveRegistry();
    log.info({ id, port, budget }, 'tenant provisioned');
    return { ...tenant };
  }

  /** Create the tenant home: symlink shared read-only code + own data/ + workspace/. */
  private _provisionHome(home: string): void {
    mkdirSync(home);
    for (const entry of SHARED_CODE_ENTRIES) {
      const target = path.join(this.sharedCodeRoot, entry);
      if (existsSync(target)) {
        symlinkSync(target, path.join(home, entry));
      }
    }
    mkdirSync(path.join(home, 'data'));
    mkdirSync(path.join(home, 'workspace'));
  }

  /**
   * Build the env block that isolates a tenant instance. Starts from an allowlist
   * of the host env (provider keys + runtime), then overrides the isolation +
   * budget keys so the instance can never inherit the host's shared token, data
   * dir, or uncapped ('off') budget.
   */
  buildTenantEnv(tenant: Tenant): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if ((ENV_PASSTHROUGH as readonly string[]).includes(k) ||
          ENV_PASSTHROUGH_PREFIXES.some((p) => k.startsWith(p))) {
        env[k] = v;
      }
    }
    // Isolation overrides (authoritative — never inherited from host).
    env['SUDO_AI_HOME'] = tenant.home;
    env['DATA_DIR'] = path.join(tenant.home, 'data');
    env['GATEWAY_PORT'] = String(tenant.port);
    env['GATEWAY_TOKEN'] = tenant.token;
    env['WEB_CHAT_TOKEN'] = tenant.token;
    // Per-instance hard cap — must NOT inherit the host's 'off'.
    env['SUDO_DAILY_BUDGET_USD'] = String(tenant.dailyBudgetUsd);
    env['SUDO_DAILY_LLM_BUDGET_USD'] = String(tenant.dailyBudgetUsd);
    return env;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start a tenant instance (idempotent if already running). */
  async start(id: string): Promise<Tenant> {
    const t = this._require(id);
    if (t.pid !== null && this.launcher.isAlive(t.pid)) {
      return { ...t };
    }
    t.status = 'starting';
    this._saveRegistry();
    try {
      const pid = await this.launcher.spawn({ ...t }, this.buildTenantEnv(t));
      t.pid = pid;
      t.status = 'running';
    } catch (err) {
      t.status = 'error';
      t.pid = null;
      this._saveRegistry();
      throw err;
    }
    this._saveRegistry();
    log.info({ id, pid: t.pid }, 'tenant started');
    return { ...t };
  }

  /** Stop a tenant instance (idempotent). */
  async stop(id: string): Promise<Tenant> {
    const t = this._require(id);
    if (t.pid !== null && this.launcher.isAlive(t.pid)) {
      await this.launcher.stop(t.pid);
    }
    t.pid = null;
    t.status = 'stopped';
    this._saveRegistry();
    log.info({ id }, 'tenant stopped');
    return { ...t };
  }

  /** Stop + delete a tenant's home (only its symlinks/data, never the shared code) and registry entry. */
  async remove(id: string): Promise<void> {
    const t = this._require(id);
    await this.stop(id);
    // rmSync unlinks symlinks rather than following them — the shared code targets are untouched.
    rmSync(t.home, { recursive: true, force: true });
    this.tenants = this.tenants.filter((x) => x.id !== id);
    this._saveRegistry();
    log.info({ id }, 'tenant removed');
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** All tenants (defensive copies). */
  list(): Tenant[] {
    return this.tenants.map((t) => ({ ...t }));
  }

  /** A single tenant by id (defensive copy), or undefined. */
  get(id: string): Tenant | undefined {
    const t = this.tenants.find((x) => x.id === id);
    return t ? { ...t } : undefined;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _require(id: string): Tenant {
    const t = this.tenants.find((x) => x.id === id);
    if (!t) throw new Error(`tenant not found: ${id}`);
    return t;
  }

  private _allocateId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'tenant';
    const suffix = randomBytes(4).toString('hex');
    return `${slug}-${suffix}`;
  }

  private _allocatePort(): number {
    const used = new Set(this.tenants.map((t) => t.port));
    for (let p = this.portRange[0]; p <= this.portRange[1]; p++) {
      if (!used.has(p)) return p;
    }
    throw new Error(`no free port in range [${this.portRange[0]}, ${this.portRange[1]}] (${this.tenants.length} tenants)`);
  }

  private _loadRegistry(): void {
    if (!existsSync(this.registryFile)) {
      this.tenants = [];
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.registryFile, 'utf8')) as unknown;
      this.tenants = Array.isArray(parsed) ? (parsed as Tenant[]) : [];
    } catch (err) {
      log.warn({ err: String(err), file: this.registryFile }, 'registry.json unreadable/corrupt — starting empty');
      this.tenants = [];
    }
  }

  private _saveRegistry(): void {
    const json = JSON.stringify(this.tenants, null, 2);
    const tmp = `${this.registryFile}.tmp.${process.pid}.${Date.now()}`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, json, 0, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.registryFile);
    // Ensure mode even if the file pre-existed with a looser umask.
    chmodSync(this.registryFile, 0o600);
  }
}
