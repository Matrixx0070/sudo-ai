/**
 * Tests for the grok-web-mcp boundary allowlist resolver — the resilience seam
 * that keeps a single conditionally-registered/absent tool from taking down the
 * whole boundary while never widening exposure beyond registered readonly tools.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition } from '../tools/types.js';
import { resolveBoundaryAllowlist } from './grok-mcp-bootstrap.js';

function tool(name: string, safety: 'readonly' | 'destructive'): ToolDefinition {
  return {
    name,
    description: name,
    category: 'system',
    safety,
    parameters: {},
    async execute() {
      return { success: true, output: 'ok' };
    },
  };
}

function registryWith(...tools: ToolDefinition[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

describe('resolveBoundaryAllowlist', () => {
  it('keeps registered readonly tools and drops absent ones', () => {
    const reg = registryWith(tool('git.status', 'readonly'), tool('github.pr_status', 'readonly'));
    const { valid, dropped } = resolveBoundaryAllowlist(reg, 'git.status,meta.search-tools,github.pr_status');
    expect(valid).toEqual(['git.status', 'github.pr_status']);
    expect(dropped).toEqual(['meta.search-tools']); // present in source, not registered at boot
  });

  it('drops a registered-but-destructive tool (never widens exposure)', () => {
    const reg = registryWith(tool('git.status', 'readonly'), tool('coder.write', 'destructive'));
    const { valid, dropped } = resolveBoundaryAllowlist(reg, 'git.status,coder.write');
    expect(valid).toEqual(['git.status']);
    expect(dropped).toEqual(['coder.write']);
  });

  it('trims whitespace and ignores empty entries', () => {
    const reg = registryWith(tool('git.status', 'readonly'));
    const { valid } = resolveBoundaryAllowlist(reg, ' git.status , , ');
    expect(valid).toEqual(['git.status']);
  });

  it('returns all-dropped when nothing matches', () => {
    const reg = registryWith(tool('git.status', 'readonly'));
    const { valid, dropped } = resolveBoundaryAllowlist(reg, 'nope.one,nope.two');
    expect(valid).toEqual([]);
    expect(dropped).toEqual(['nope.one', 'nope.two']);
  });
});
