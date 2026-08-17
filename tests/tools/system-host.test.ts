/**
 * @file system-host.test.ts
 * @description system.host — the agent's full host/system + geo-IP view.
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { registerSystemTools } from '../../src/core/tools/builtin/system/index.js';
import type { ToolContext } from '../../src/core/tools/types.js';

function ctx(): ToolContext {
  return { sessionId: 't', workingDir: '/tmp', config: {}, logger: { info() {}, warn() {}, error() {}, debug() {} } } as ToolContext;
}

describe('system.host tool', () => {
  it('registers as a read-only system tool', async () => {
    const reg = new ToolRegistry();
    await registerSystemTools(reg);
    const t = reg.get('system.host');
    expect(t).toBeDefined();
    expect(t!.category).toBe('system');
    expect(t!.safety).toBe('readonly');
  });

  it('reports full system details (geo off = no network)', async () => {
    const reg = new ToolRegistry();
    await registerSystemTools(reg);
    const res = await reg.get('system.host')!.execute({ geo: false }, ctx());
    expect(res.success).toBe(true);
    const sys = (res.data as { system: Record<string, unknown> }).system;
    // Core system fields are always present.
    for (const k of ['hostname', 'os', 'kernel', 'arch', 'cpu', 'cpuCores', 'memory', 'hostUptime', 'node', 'installDir', 'timezone', 'container', 'localIPs']) {
      expect(sys[k]).toBeDefined();
    }
    expect(res.output).toMatch(/Host \/ system/i);
    // geo omitted when geo:false
    expect((res.data as { geo?: unknown }).geo).toBeUndefined();
  }, 15_000);
});
