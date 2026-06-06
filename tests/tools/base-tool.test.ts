import { describe, it, expect, vi } from 'vitest';
import { BaseTool, Tool, __toolClass } from '../../src/core/tools/base-tool.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolDefinition, ToolParam, ToolContext, ToolResult, ToolClassMetadata } from '../../src/core/tools/base-tool.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: '/tmp',
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

class EchoTool extends BaseTool {
  readonly name = 'test.echo';
  readonly description = 'Echoes back the input';
  readonly parameters: Record<string, ToolParam> = {
    message: { type: 'string', description: 'Message to echo', required: true },
  };
  category: ToolDefinition['category'] = 'coder';

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    return { success: true, output: String(params.message) };
  }
}

// Apply Tool decorator as a regular function (avoids needing experimentalDecorators)
class DecoratedTool extends BaseTool {
  readonly name = 'test.decorated';
  readonly description = 'A decorated tool';
  readonly parameters: Record<string, ToolParam> = {};
  async execute() { return { success: true, output: 'decorated' } as ToolResult; }
}
// Apply decorator manually: Tool(name, desc, meta)(Class)
Tool('test.decorated', 'A decorated tool', { costEstimate: 'low', profile: 'coding' })(DecoratedTool);

class FullProfileTool extends BaseTool {
  readonly name = 'test.full-profile';
  readonly description = 'Full profile tool';
  readonly parameters: Record<string, ToolParam> = {};
  async execute() { return { success: true, output: 'full' } as ToolResult; }
}
Tool('test.full-profile', 'Full profile tool', { profile: 'full' })(FullProfileTool);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BaseTool', () => {
  it('extends BaseTool creates a valid tool', () => {
    const tool = new EchoTool();
    expect(tool.name).toBe('test.echo');
    expect(tool.description).toBe('Echoes back the input');
    expect(tool.category).toBe('coder');
    expect(tool.parameters.message.type).toBe('string');
  });

  it('toDefinition converts to ToolDefinition', () => {
    const tool = new EchoTool();
    const def: ToolDefinition = tool.toDefinition();
    expect(def.name).toBe('test.echo');
    expect(def.description).toBe('Echoes back the input');
    expect(def.category).toBe('coder');
    expect(def.parameters).toEqual(tool.parameters);
    expect(typeof def.execute).toBe('function');
  });

  it('toDefinition preserves execute behavior', async () => {
    const tool = new EchoTool();
    const def = tool.toDefinition();
    const result = await def.execute({ message: 'hello' }, makeContext());
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello');
  });

  it('metadata defaults are set', () => {
    const tool = new EchoTool();
    expect(tool.metadata.costEstimate).toBe('free');
    expect(tool.metadata.latencyEstimate).toBe('instant');
    expect(tool.metadata.requiresConfirmation).toBe(false);
    expect(tool.metadata.profile).toBe('minimal');
  });

  it('tool registration via registerAll', () => {
    const registry = new ToolRegistry();
    BaseTool.registerAll([EchoTool], registry);
    const def = registry.get('test.echo');
    expect(def).toBeDefined();
    expect(def!.name).toBe('test.echo');
  });

  it('category defaults to custom when not overridden', () => {
    class PlainTool extends BaseTool {
      readonly name = 'test.plain';
      readonly description = 'A plain tool';
      readonly parameters: Record<string, ToolParam> = {};
      async execute() { return { success: true, output: 'ok' } as ToolResult; }
    }
    const tool = new PlainTool();
    expect(tool.category).toBe('custom');
  });
});

describe('@Tool decorator', () => {
  it('adds metadata to the class constructor', () => {
    const meta = (DecoratedTool as unknown as Record<symbol, ToolClassMetadata>)[__toolClass];
    expect(meta).toBeDefined();
    expect(meta.name).toBe('test.decorated');
    expect(meta.description).toBe('A decorated tool');
    expect(meta.metadata.costEstimate).toBe('low');
    expect(meta.metadata.profile).toBe('coding');
  });

  it('decorator merges partial metadata with defaults', () => {
    const meta = (DecoratedTool as unknown as Record<symbol, ToolClassMetadata>)[__toolClass];
    // costEstimate overridden to 'low', others stay default
    expect(meta.metadata.costEstimate).toBe('low');
    expect(meta.metadata.latencyEstimate).toBe('instant');
    expect(meta.metadata.requiresConfirmation).toBe(false);
  });

  it('decorated tool can still be instantiated and executed', async () => {
    const tool = new DecoratedTool();
    const result = await tool.execute({}, makeContext());
    expect(result.success).toBe(true);
    expect(result.output).toBe('decorated');
  });

  it('tool profile can be set via decorator metadata', () => {
    const meta = (FullProfileTool as unknown as Record<symbol, ToolClassMetadata>)[__toolClass];
    expect(meta.metadata.profile).toBe('full');
    expect(meta.name).toBe('test.full-profile');
  });
});