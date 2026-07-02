/**
 * @file tests/tenancy/launcher-fail-closed.test.ts
 * @description The default tenant launcher provides NO OS isolation (same-user
 * spawn), so it must FAIL CLOSED — refuse to spawn unless the operator
 * explicitly accepts the risk via SUDO_TENANCY_ALLOW_UNSAFE=1. A real isolating
 * launcher is injected separately and bypasses this guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ pid: 4242, unref: vi.fn() })));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { defaultTenantLauncher } from '../../src/core/tenancy/tenant-launcher.js';
import type { Tenant } from '../../src/core/tenancy/types.js';

const tenant = { id: 't1', home: '/tmp/tenant-t1', port: 19001 } as Tenant;

describe('defaultTenantLauncher fail-closed isolation guard', () => {
  const saved = process.env['SUDO_TENANCY_ALLOW_UNSAFE'];
  beforeEach(() => { spawnMock.mockClear(); delete process.env['SUDO_TENANCY_ALLOW_UNSAFE']; });
  afterEach(() => {
    if (saved === undefined) delete process.env['SUDO_TENANCY_ALLOW_UNSAFE'];
    else process.env['SUDO_TENANCY_ALLOW_UNSAFE'] = saved;
  });

  it('refuses to spawn without the explicit opt-out (fail-closed) and never spawns a process', async () => {
    await expect(defaultTenantLauncher.spawn(tenant, {})).rejects.toThrow(/refusing to spawn/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('the refusal names the isolation risk', async () => {
    await expect(defaultTenantLauncher.spawn(tenant, {})).rejects.toThrow(/isolation|same OS user|secrets/i);
  });

  it('spawns only when SUDO_TENANCY_ALLOW_UNSAFE=1 is set explicitly', async () => {
    process.env['SUDO_TENANCY_ALLOW_UNSAFE'] = '1';
    const pid = await defaultTenantLauncher.spawn(tenant, {});
    expect(pid).toBe(4242);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('any value other than exactly "1" still fails closed', async () => {
    process.env['SUDO_TENANCY_ALLOW_UNSAFE'] = 'true';
    await expect(defaultTenantLauncher.spawn(tenant, {})).rejects.toThrow(/refusing to spawn/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
