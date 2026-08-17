/**
 * @file meta-status.test.ts
 * @description meta.status — the agent's read-only view of its own live status.
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { registerMetaTools } from '../../src/core/tools/builtin/meta/index.js';
import type { ToolContext } from '../../src/core/tools/types.js';

function ctx(): ToolContext {
  return { sessionId: 't', workingDir: '/tmp', config: {}, logger: { info() {}, warn() {}, error() {}, debug() {} } } as ToolContext;
}

describe('meta.status tool', () => {
  it('is registered as a read-only meta tool', () => {
    const reg = new ToolRegistry();
    registerMetaTools(reg);
    const t = reg.get('meta.status');
    expect(t).toBeDefined();
    expect(t!.category).toBe('meta');
    expect(t!.safety).toBe('readonly');
  });

  it('reports live activity (idle when no runs are active)', async () => {
    const reg = new ToolRegistry();
    registerMetaTools(reg);
    const res = await reg.get('meta.status')!.execute({}, ctx());
    expect(res.success).toBe(true);
    // No active runs in a fresh registry → idle; the activity line is always present.
    expect(res.output).toMatch(/idle|working/i);
    expect((res.data as { activity: string }).activity).toMatch(/idle|working/i);
    expect(Array.isArray((res.data as { activeRuns: unknown[] }).activeRuns)).toBe(true);
  }, 15_000);
});
