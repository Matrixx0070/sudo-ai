/**
 * @file tests/health/self-test.test.ts
 * @description Tests for runCapabilitySelfTest against a stub registry — no
 *   real tools, no browser (SUDO_SELFTEST_BROWSER=0).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCapabilitySelfTest, type SelfTestRegistry } from '../../src/core/health/self-test.js';
import * as proactiveNotifier from '../../src/core/awareness/proactive-notifier.js';
import type { ToolResult } from '../../src/core/tools/types.js';

function stubRegistry(behavior: (name: string) => ToolResult | Error): SelfTestRegistry {
  return {
    get: () => ({}),
    execute: async (name: string): Promise<ToolResult> => {
      const r = behavior(name);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('runCapabilitySelfTest', () => {
  const savedBrowser = process.env['SUDO_SELFTEST_BROWSER'];
  const savedDisable = process.env['SUDO_SELFTEST_DISABLE'];

  beforeEach(() => {
    process.env['SUDO_SELFTEST_BROWSER'] = '0';
    delete process.env['SUDO_SELFTEST_DISABLE'];
  });

  afterEach(() => {
    if (savedBrowser === undefined) delete process.env['SUDO_SELFTEST_BROWSER'];
    else process.env['SUDO_SELFTEST_BROWSER'] = savedBrowser;
    if (savedDisable === undefined) delete process.env['SUDO_SELFTEST_DISABLE'];
    else process.env['SUDO_SELFTEST_DISABLE'] = savedDisable;
  });

  it('counts throwing tools as failures and emits a high-priority notification', async () => {
    const notifications: Array<{ title: string; priority: string }> = [];
    const unsubscribe = proactiveNotifier.onNotification((n) => {
      notifications.push({ title: n.title, priority: n.priority });
    });

    try {
      // File-producing cases fail on the "no output file written" path (stub
      // writes nothing); health-check cases throw. Everything must be counted.
      const registry = stubRegistry((name) =>
        name === 'meta.health-check' ? new Error('boom') : { success: true, output: 'ok' },
      );
      const result = await runCapabilitySelfTest(registry);

      expect(result.total).toBeGreaterThan(0);
      expect(result.failed.length).toBeGreaterThan(0);
      expect(result.failed.some((f) => f.error.includes('boom'))).toBe(true);
      expect(result.passed + result.failed.length).toBe(result.total);

      expect(notifications).toHaveLength(1);
      expect(notifications[0].title).toMatch(/self-test/i);
      expect(notifications[0].priority).toBe('high');
    } finally {
      unsubscribe();
    }
  });

  it('skips unregistered tools instead of failing them', async () => {
    const unsubscribe = proactiveNotifier.onNotification(() => {});
    try {
      const registry: SelfTestRegistry = {
        get: () => undefined,
        execute: async () => ({ success: true, output: 'ok' }),
      };
      const result = await runCapabilitySelfTest(registry);
      expect(result.total).toBe(0);
      expect(result.failed).toHaveLength(0);
      expect(result.skipped.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });

  it('SUDO_SELFTEST_DISABLE=1 short-circuits without executing anything', async () => {
    process.env['SUDO_SELFTEST_DISABLE'] = '1';
    let executed = 0;
    const registry: SelfTestRegistry = {
      get: () => ({}),
      execute: async () => {
        executed++;
        return { success: true, output: 'ok' };
      },
    };
    const result = await runCapabilitySelfTest(registry);
    expect(executed).toBe(0);
    expect(result.total).toBe(0);
    expect(result.skipped[0]).toContain('SUDO_SELFTEST_DISABLE');
  });
});
