import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync, realpathSync, statSync, rmSync,
} from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { TenantManager } from '../../src/core/tenancy/tenant-manager.js';
import type { Tenant, TenantLauncher } from '../../src/core/tenancy/types.js';

/** Mock launcher: records calls, hands out fake incrementing pids, tracks aliveness. */
function makeMockLauncher() {
  const alive = new Set<number>();
  let nextPid = 1000;
  const spawns: Array<{ tenant: Tenant; env: NodeJS.ProcessEnv }> = [];
  const stops: number[] = [];
  const launcher: TenantLauncher = {
    spawn: (tenant, env) => { const pid = ++nextPid; alive.add(pid); spawns.push({ tenant, env }); return Promise.resolve(pid); },
    stop: (pid) => { alive.delete(pid); stops.push(pid); return Promise.resolve(); },
    isAlive: (pid) => alive.has(pid),
  };
  return { launcher, spawns, stops, alive };
}

describe('TenantManager (Stage 1 control plane)', () => {
  let controlPlaneDir: string;
  let sharedCodeRoot: string;

  beforeEach(() => {
    controlPlaneDir = mkdtempSync(path.join(tmpdir(), 'tnt-cp-'));
    sharedCodeRoot = mkdtempSync(path.join(tmpdir(), 'tnt-code-'));
    // Dummy shared code so symlink targets exist.
    mkdirSync(path.join(sharedCodeRoot, 'src'));
    mkdirSync(path.join(sharedCodeRoot, 'config'));
    writeFileSync(path.join(sharedCodeRoot, 'src', 'cli.ts'), '// dummy');
    writeFileSync(path.join(sharedCodeRoot, 'package.json'), '{}');
  });
  afterEach(() => {
    rmSync(controlPlaneDir, { recursive: true, force: true });
    rmSync(sharedCodeRoot, { recursive: true, force: true });
  });

  const mk = (over?: Partial<{ portRange: [number, number]; launcher: TenantLauncher }>) =>
    new TenantManager({ controlPlaneDir, sharedCodeRoot, portRange: over?.portRange, launcher: over?.launcher });

  it('createTenant: allocates a port in range, a strong token, an isolated home with symlinked code + own data/workspace, and stores the budget', () => {
    const { launcher } = makeMockLauncher();
    const m = mk({ launcher, portRange: [19000, 19999] });
    const t = m.createTenant({ name: 'Acme Corp', dailyBudgetUsd: 5 });

    expect(t.port).toBeGreaterThanOrEqual(19000);
    expect(t.port).toBeLessThanOrEqual(19999);
    expect(t.token.length).toBeGreaterThanOrEqual(24);
    expect(t.dailyBudgetUsd).toBe(5);
    expect(t.status).toBe('provisioned');
    expect(t.pid).toBeNull();
    expect(t.id).toMatch(/^acme-corp-[0-9a-f]+$/);

    // shared code symlinked, resolving to the shared root
    const srcLink = path.join(t.home, 'src');
    expect(lstatSync(srcLink).isSymbolicLink()).toBe(true);
    expect(realpathSync(srcLink)).toBe(realpathSync(path.join(sharedCodeRoot, 'src')));
    expect(lstatSync(path.join(t.home, 'package.json')).isSymbolicLink()).toBe(true);
    // own real data + workspace dirs (NOT symlinks)
    expect(statSync(path.join(t.home, 'data')).isDirectory()).toBe(true);
    expect(lstatSync(path.join(t.home, 'data')).isSymbolicLink()).toBe(false);
    expect(statSync(path.join(t.home, 'workspace')).isDirectory()).toBe(true);
  });

  it('createTenant: rejects empty name, over-long name, and uncapped/invalid budgets', () => {
    const m = mk();
    expect(() => m.createTenant({ name: '', dailyBudgetUsd: 5 })).toThrow();
    expect(() => m.createTenant({ name: 'x'.repeat(65), dailyBudgetUsd: 5 })).toThrow();
    // budget cap is REQUIRED — these must all be rejected
    expect(() => m.createTenant({ name: 'a', dailyBudgetUsd: 0 })).toThrow();
    expect(() => m.createTenant({ name: 'a', dailyBudgetUsd: -1 })).toThrow();
    expect(() => m.createTenant({ name: 'a', dailyBudgetUsd: Number.NaN })).toThrow();
    expect(() => m.createTenant({ name: 'a', dailyBudgetUsd: 100000 })).toThrow();
    // @ts-expect-error missing budget
    expect(() => m.createTenant({ name: 'a' })).toThrow();
  });

  it('port allocation: distinct ports per tenant; throws when the range is exhausted', () => {
    const m = mk({ portRange: [19000, 19001] }); // exactly 2 ports
    const a = m.createTenant({ name: 'a', dailyBudgetUsd: 1 });
    const b = m.createTenant({ name: 'b', dailyBudgetUsd: 1 });
    expect(a.port).not.toBe(b.port);
    expect(() => m.createTenant({ name: 'c', dailyBudgetUsd: 1 })).toThrow(/no free port/);
  });

  it('buildTenantEnv: sets isolation + budget overrides; passes provider keys but not arbitrary host env', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test-passthrough';
    process.env['SOME_RANDOM_HOST_SECRET'] = 'should-not-leak';
    process.env['SUDO_DAILY_BUDGET_USD'] = 'off'; // host is uncapped — must NOT inherit
    try {
      const m = mk();
      const t = m.createTenant({ name: 'envtest', dailyBudgetUsd: 7.5 });
      const env = m.buildTenantEnv(t);
      expect(env['SUDO_AI_HOME']).toBe(t.home);
      expect(env['DATA_DIR']).toBe(path.join(t.home, 'data'));
      expect(env['GATEWAY_PORT']).toBe(String(t.port));
      expect(env['GATEWAY_TOKEN']).toBe(t.token);
      expect(env['WEB_CHAT_TOKEN']).toBe(t.token);
      expect(env['SUDO_DAILY_BUDGET_USD']).toBe('7.5'); // the per-instance cap, NOT 'off'
      expect(env['SUDO_DAILY_LLM_BUDGET_USD']).toBe('7.5');
      expect(env['OPENAI_API_KEY']).toBe('sk-test-passthrough');
      expect(env['SOME_RANDOM_HOST_SECRET']).toBeUndefined();
    } finally {
      delete process.env['OPENAI_API_KEY'];
      delete process.env['SOME_RANDOM_HOST_SECRET'];
      delete process.env['SUDO_DAILY_BUDGET_USD'];
    }
  });

  it('start: spawns via the launcher with the tenant env, sets running+pid, idempotent while alive', async () => {
    const { launcher, spawns } = makeMockLauncher();
    const m = mk({ launcher });
    const t = m.createTenant({ name: 'svc', dailyBudgetUsd: 2 });
    const started = await m.start(t.id);
    expect(started.status).toBe('running');
    expect(started.pid).not.toBeNull();
    expect(spawns).toHaveLength(1);
    expect(spawns[0].env['GATEWAY_TOKEN']).toBe(t.token);
    // idempotent: second start does not re-spawn
    await m.start(t.id);
    expect(spawns).toHaveLength(1);
  });

  it('stop: stops via launcher, clears pid, status stopped', async () => {
    const { launcher, stops } = makeMockLauncher();
    const m = mk({ launcher });
    const t = m.createTenant({ name: 'svc', dailyBudgetUsd: 2 });
    const started = await m.start(t.id);
    const stopped = await m.stop(t.id);
    expect(stops).toContain(started.pid);
    expect(stopped.pid).toBeNull();
    expect(stopped.status).toBe('stopped');
  });

  it('remove: stops + deletes the tenant home + registry entry, leaving the shared code intact', async () => {
    const { launcher } = makeMockLauncher();
    const m = mk({ launcher });
    const t = m.createTenant({ name: 'gone', dailyBudgetUsd: 2 });
    await m.start(t.id);
    await m.remove(t.id);
    expect(m.get(t.id)).toBeUndefined();
    expect(existsSync(t.home)).toBe(false);
    // the symlink targets (shared code) survive
    expect(existsSync(path.join(sharedCodeRoot, 'src', 'cli.ts'))).toBe(true);
  });

  it('persistence: a fresh manager loads tenants from registry.json (0o600)', () => {
    const m1 = mk();
    const t = m1.createTenant({ name: 'persist', dailyBudgetUsd: 3 });
    const registry = path.join(controlPlaneDir, 'registry.json');
    expect(existsSync(registry)).toBe(true);
    expect(statSync(registry).mode & 0o777).toBe(0o600);

    const m2 = new TenantManager({ controlPlaneDir, sharedCodeRoot });
    const loaded = m2.get(t.id);
    expect(loaded).toBeDefined();
    expect(loaded?.token).toBe(t.token);
    expect(loaded?.port).toBe(t.port);
    expect(loaded?.dailyBudgetUsd).toBe(3);
  });
});
