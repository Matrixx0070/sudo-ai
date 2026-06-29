import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaPatcher, type PatchContext } from '../../src/core/tools/schema-patcher.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, category: ToolDefinition['category'] = 'coder'): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    category,
    parameters: { msg: { type: 'string', description: 'input', required: true } },
    execute: async () => ({ success: true, output: 'ok' } as ToolResult),
  };
}

function makeSchemas(registry: ToolRegistry): object[] {
  return registry.getSchemaForLLM();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchemaPatcher', () => {
  let registry: ToolRegistry;
  let patcher: SchemaPatcher;

  beforeEach(() => {
    registry = new ToolRegistry();
    // Register tools using the REAL dot-namespaced names the profiles reference.
    registry.register(makeTool('fs.read'));
    registry.register(makeTool('fs.write'));
    registry.register(makeTool('system.exec'));
    registry.register(makeTool('browser.search'));
    registry.register(makeTool('fs.edit'));
    registry.register(makeTool('fs.multi-edit'));
    registry.register(makeTool('coder.read-file'));
    registry.register(makeTool('coder.write-file'));
    registry.register(makeTool('coder.smart-edit'));
    registry.register(makeTool('coder.git'));
    registry.register(makeTool('coder.npm'));
    registry.register(makeTool('coder.test'));
    registry.register(makeTool('coder.typecheck'));
    registry.register(makeTool('coder.debug'));
    registry.register(makeTool('browser.navigate'));
    registry.register(makeTool('browser.screenshot'));
    patcher = new SchemaPatcher(registry);
  });

  const baseContext: PatchContext = {
    model: 'gpt-4o',
    maxTools: 128,
    profile: 'full',
    disabledTools: [],
    requiredCategories: [],
  };

  it('patch reduces tool count by profile', () => {
    const schemas = makeSchemas(registry);
    const result = patcher.patch(schemas, { ...baseContext, profile: 'minimal' });
    expect(result.patchedCount).toBeLessThan(result.originalCount);
    expect(result.originalCount).toBe(schemas.length);
  });

  it('minimal profile keeps only core tools', () => {
    const schemas = makeSchemas(registry);
    const result = patcher.patch(schemas, { ...baseContext, profile: 'minimal' });
    // Minimal: fs.read, fs.write, system.exec, browser.search
    expect(result.kept).toContain('fs.read');
    expect(result.kept).toContain('fs.write');
    expect(result.kept).toContain('system.exec');
    expect(result.kept).toContain('browser.search');
    expect(result.kept).not.toContain('browser.navigate');
  });

  it('coding profile extends minimal', () => {
    const schemas = makeSchemas(registry);
    const result = patcher.patch(schemas, { ...baseContext, profile: 'coding' });
    expect(result.kept).toContain('fs.read');
    expect(result.kept).toContain('fs.edit');
    expect(result.kept).toContain('coder.git');
    expect(result.kept).toContain('coder.npm');
    expect(result.kept).not.toContain('browser.navigate');
  });

  it('full profile keeps all tools', () => {
    const schemas = makeSchemas(registry);
    const result = patcher.patch(schemas, { ...baseContext, profile: 'full' });
    expect(result.patchedCount).toBe(result.originalCount);
  });

  it('model limit is respected', () => {
    const schemas = makeSchemas(registry);
    const result = patcher.patch(schemas, { ...baseContext, maxTools: 2 });
    expect(result.patchedCount).toBeLessThanOrEqual(2);
  });

  it('disabled tools are removed', () => {
    const schemas = makeSchemas(registry);
    const result = patcher.patch(schemas, {
      ...baseContext,
      disabledTools: ['system.exec', 'browser.search'],
    });
    expect(result.removed).toContain('system.exec');
    expect(result.removed).toContain('browser.search');
    expect(result.kept).not.toContain('system.exec');
  });

  it('stats accumulate across patches', () => {
    const schemas = makeSchemas(registry);
    patcher.patch(schemas, { ...baseContext, profile: 'minimal' });
    patcher.patch(schemas, { ...baseContext, profile: 'coding' });
    const stats = patcher.getStats();
    expect(stats.totalPatches).toBe(2);
    expect(stats.avgReduction).toBeGreaterThan(0);
    expect(stats.byProfile.minimal).toBe(1);
    expect(stats.byProfile.coding).toBe(1);
  });

  it('token savings are estimated in result', () => {
    const schemas = makeSchemas(registry);
    const result = patcher.patch(schemas, { ...baseContext, profile: 'minimal' });
    expect(result.savings.estimatedTokens).toBeGreaterThanOrEqual(0);
    // When tools are removed, savings should be positive
    if (result.removed.length > 0) {
      expect(result.savings.estimatedTokens).toBeGreaterThan(0);
    }
  });
});