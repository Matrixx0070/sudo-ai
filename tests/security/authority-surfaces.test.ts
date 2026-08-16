/**
 * @file authority-surfaces.test.ts
 * @description Integration pins: every approval surface consults the central
 * execution authority. Before centralization these disagreed (measured
 * 2026-08-16) — PermissionManager honoured SUDO_AUTO_APPROVE, system.exec
 * honoured EXEC_APPROVAL_MODE (read once at import, so unchangeable at
 * runtime), and graph gates honoured neither and parked forever.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PermissionManager } from '../../src/core/agent/permissions.js';
import { approvalManager } from '../../src/core/agent/approval.js';
import { createApprovalGateExecutor } from '../../src/core/orchestration/graph-approval.js';
import type { GraphRunStore } from '../../src/core/orchestration/graph-run-store.js';

const ENV_KEYS = ['SUDO_AUTHORITY_MODE', 'SUDO_AUTO_APPROVE'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('surface: PermissionManager', () => {
  it('resolves every tool to auto under autonomous authority', () => {
    const pm = PermissionManager.getInstance();
    for (const tool of ['system.ssh', 'system.exec', 'system.nginx', 'files.delete', 'anything.at.all']) {
      expect(pm.check(tool), tool).toBe('auto');
    }
  });

  it('autonomy overrides even an EXPLICIT ask rule; gated mode honours it', () => {
    // NOTE (measured): DEFAULT_PERMISSIONS is already all-'auto' with an
    // 'auto' fallback, so the honest discriminator is an explicit override —
    // the strongest statement of operator intent the table can carry.
    const pm = PermissionManager.getInstance();
    pm.override('system.ssh', 'ask', 'test: explicit ask rule');
    try {
      expect(pm.check('system.ssh')).toBe('auto'); // autonomous wins

      process.env['SUDO_AUTHORITY_MODE'] = 'gated';
      expect(pm.check('system.ssh')).toBe('ask'); // gated defers to the rule
    } finally {
      pm.reset('system.ssh');
    }
  });
});

describe('surface: ApprovalManager', () => {
  it('returns approved immediately and sends NOTHING to any channel', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    approvalManager.registerSender('telegram', { send });

    const approved = await approvalManager.requestApproval(
      'system.ssh',
      { host: 'localhost', command: 'hostname' },
      'telegram',
      'peer-1',
    );

    expect(approved).toBe(true);
    // The user must never see a prompt — this is the whole directive.
    expect(send).not.toHaveBeenCalled();
  });

  it('resolves without waiting on the 60s prompt timeout', async () => {
    const t0 = Date.now();
    await approvalManager.requestApproval('system.nginx', { action: 'reload' }, 'telegram', 'peer-1');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('surface: orchestration graph gate', () => {
  function stubStore(status?: 'approved' | 'denied' | 'pending'): GraphRunStore {
    return {
      getApproval: () => (status ? { status, decidedBy: 'operator' } : undefined),
      requestApproval: vi.fn().mockReturnValue(true),
    } as unknown as GraphRunStore;
  }

  const node = { id: 'gate-1', kind: 'gate', config: {} } as never;

  it('passes through instead of parking (no human interruption)', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const exec = createApprovalGateExecutor({ store: stubStore(), runId: 'run-1', notify });

    const res = await exec(node, [{ output: { carried: true } }] as never, new AbortController().signal);

    expect(res.success).toBe(true);
    expect((res as { park?: boolean }).park).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('still honours an explicit prior DENY (a decision, not a question)', async () => {
    const exec = createApprovalGateExecutor({ store: stubStore('denied'), runId: 'run-1' });
    const res = await exec(node, [] as never, new AbortController().signal);
    expect(res.success).toBe(false);
  });

  it('parks again in gated mode (proves the gate machinery still works)', async () => {
    process.env['SUDO_AUTHORITY_MODE'] = 'gated';
    const exec = createApprovalGateExecutor({ store: stubStore(), runId: 'run-1' });
    const res = await exec(node, [] as never, new AbortController().signal);
    expect((res as { park?: boolean }).park).toBe(true);
  });
});
