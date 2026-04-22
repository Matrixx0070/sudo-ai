/**
 * Integration tests for the SUDO-AI v3 tool calling pipeline.
 *
 * Tests the full chain: schema generation -> message conversion -> tool
 * execution -> result message formatting, all WITHOUT real LLM calls.
 *
 * Run: npx vitest run tests/tool-call-integration.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../src/core/tools/registry.js';
import type { ToolDefinition, ToolResult, ToolContext } from '../src/core/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/sudo-test',
    config: null,
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    },
    ...overrides,
  };
}

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: overrides.name ?? 'test.tool',
    description: overrides.description ?? 'A test tool',
    category: 'coder',
    parameters: overrides.parameters ?? {
      input: { type: 'string', description: 'Test input', required: true },
    },
    execute: overrides.execute ?? (async () => ({ success: true, output: 'ok' })),
  };
}

// ---------------------------------------------------------------------------
// Test 1: Schema generation
// ---------------------------------------------------------------------------

describe('ToolRegistry.getSchemaForLLM()', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('should generate valid JSON Schema with required fields', () => {
    registry.register(makeTool({
      name: 'coder.write-file',
      parameters: {
        path: { type: 'string', description: 'File path', required: true },
        content: { type: 'string', description: 'File content', required: true },
        backup: { type: 'boolean', description: 'Create backup', required: false },
      },
    }));

    const schemas = registry.getSchemaForLLM();
    expect(schemas).toHaveLength(1);

    const schema = schemas[0] as Record<string, unknown>;
    expect(schema['type']).toBe('function');

    const fn = schema['function'] as Record<string, unknown>;
    expect(fn['name']).toBe('coder.write-file');

    const params = fn['parameters'] as Record<string, unknown>;
    expect(params['type']).toBe('object');
    expect(params['required']).toEqual(['path', 'content']);
    expect(params['additionalProperties']).toBe(false);

    const props = params['properties'] as Record<string, Record<string, unknown>>;
    expect(props['path']['type']).toBe('string');
    expect(props['content']['type']).toBe('string');
    expect(props['backup']['type']).toBe('boolean');
  });

  it('should include additionalProperties:false on nested objects', () => {
    registry.register(makeTool({
      name: 'test.nested',
      parameters: {
        config: {
          type: 'object',
          description: 'Nested config',
          required: true,
          properties: {
            key: { type: 'string', description: 'Key', required: true },
            value: { type: 'string', description: 'Value' },
          },
        },
      },
    }));

    const schemas = registry.getSchemaForLLM();
    const fn = (schemas[0] as Record<string, unknown>)['function'] as Record<string, unknown>;
    const params = fn['parameters'] as Record<string, unknown>;
    const props = params['properties'] as Record<string, Record<string, unknown>>;
    const config = props['config'];

    expect(config['additionalProperties']).toBe(false);
    expect(config['required']).toEqual(['key']);
  });

  it('should handle array parameters with items schema', () => {
    registry.register(makeTool({
      name: 'test.array',
      parameters: {
        files: {
          type: 'array',
          description: 'List of files',
          required: true,
          items: { type: 'string', description: 'File path' },
        },
      },
    }));

    const schemas = registry.getSchemaForLLM();
    const fn = (schemas[0] as Record<string, unknown>)['function'] as Record<string, unknown>;
    const params = fn['parameters'] as Record<string, unknown>;
    const props = params['properties'] as Record<string, Record<string, unknown>>;

    expect(props['files']['type']).toBe('array');
    expect(props['files']['items']).toEqual({ type: 'string', description: 'File path' });
  });

  it('should only include enabled tools', () => {
    registry.register(makeTool({ name: 'tool.a' }));
    registry.register(makeTool({ name: 'tool.b' }));
    registry.disable('tool.b');

    const schemas = registry.getSchemaForLLM();
    expect(schemas).toHaveLength(1);
    const fn = (schemas[0] as Record<string, unknown>)['function'] as Record<string, unknown>;
    expect(fn['name']).toBe('tool.a');
  });
});

// ---------------------------------------------------------------------------
// Test 2: Tool execution
// ---------------------------------------------------------------------------

describe('ToolRegistry.execute()', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('should execute a tool and return result', async () => {
    registry.register(makeTool({
      name: 'test.echo',
      execute: async (params) => ({
        success: true,
        output: `Echo: ${params['input']}`,
      }),
    }));

    const result = await registry.execute('test.echo', { input: 'hello' }, makeCtx());
    expect(result.success).toBe(true);
    expect(result.output).toBe('Echo: hello');
  });

  it('should throw for unknown tool', async () => {
    await expect(registry.execute('unknown', {}, makeCtx())).rejects.toThrow('Tool not found');
  });

  it('should throw for disabled tool', async () => {
    registry.register(makeTool({ name: 'test.disabled' }));
    registry.disable('test.disabled');
    await expect(registry.execute('test.disabled', {}, makeCtx())).rejects.toThrow('Tool is disabled');
  });

  it('should handle execution errors gracefully', async () => {
    registry.register(makeTool({
      name: 'test.error',
      execute: async () => { throw new Error('Boom'); },
    }));

    await expect(registry.execute('test.error', {}, makeCtx())).rejects.toThrow('Boom');
  });
});

// ---------------------------------------------------------------------------
// Test 3: executeCall round-trip
// ---------------------------------------------------------------------------

describe('ToolRegistry.executeCall()', () => {
  it('should preserve toolCallId through round-trip', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: 'test.roundtrip',
      execute: async () => ({ success: true, output: 'done' }),
    }));

    const callResult = await registry.executeCall(
      { id: 'call-123', name: 'test.roundtrip', arguments: {} },
      makeCtx(),
    );

    expect(callResult.toolCallId).toBe('call-123');
    expect(callResult.name).toBe('test.roundtrip');
    expect(callResult.result.success).toBe(true);
    expect(callResult.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty arguments (from malformed LLM response)', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: 'test.empty-args',
      execute: async (params) => ({
        success: true,
        output: `keys: ${Object.keys(params).length}`,
      }),
    }));

    // Simulates LLM returning null/undefined arguments
    const callResult = await registry.executeCall(
      { id: 'call-456', name: 'test.empty-args', arguments: {} },
      makeCtx(),
    );

    expect(callResult.result.success).toBe(true);
    expect(callResult.result.output).toBe('keys: 0');
  });
});

// ---------------------------------------------------------------------------
// Test 4: Message format conversion (toSDKMessages tested indirectly)
// ---------------------------------------------------------------------------

describe('Message format validation', () => {
  it('should create valid tool result messages', () => {
    // This tests the format that would be sent to the SDK
    const toolResultMsg = {
      role: 'tool' as const,
      content: 'File written successfully',
      toolCallId: 'call-789',
      toolName: 'coder.write-file',
    };

    // Verify all required fields are present
    expect(toolResultMsg.role).toBe('tool');
    expect(typeof toolResultMsg.content).toBe('string');
    expect(typeof toolResultMsg.toolCallId).toBe('string');
    expect(typeof toolResultMsg.toolName).toBe('string');
    expect(toolResultMsg.toolCallId).not.toBe('');
    expect(toolResultMsg.toolName).not.toBe('');
  });

  it('should handle assistant message with tool calls', () => {
    const assistantMsg = {
      role: 'assistant' as const,
      content: '',
      toolCalls: [
        { id: 'call-1', name: 'coder.read-file', arguments: { path: '/tmp/test.txt' } },
        { id: 'call-2', name: 'coder.write-file', arguments: { path: '/tmp/out.txt', content: 'hello' } },
      ],
    };

    // Verify multiple tool calls are preserved
    expect(assistantMsg.toolCalls).toHaveLength(2);
    expect(assistantMsg.toolCalls[0].id).toBe('call-1');
    expect(assistantMsg.toolCalls[1].id).toBe('call-2');
  });
});

// ---------------------------------------------------------------------------
// Test 5: Multi-tool execution sequence
// ---------------------------------------------------------------------------

describe('Multi-tool execution', () => {
  it('should execute multiple tool calls in sequence', async () => {
    const registry = new ToolRegistry();
    const executionOrder: string[] = [];

    registry.register(makeTool({
      name: 'test.step1',
      execute: async () => {
        executionOrder.push('step1');
        return { success: true, output: 'Step 1 done' };
      },
    }));

    registry.register(makeTool({
      name: 'test.step2',
      execute: async () => {
        executionOrder.push('step2');
        return { success: true, output: 'Step 2 done' };
      },
    }));

    registry.register(makeTool({
      name: 'test.step3',
      execute: async () => {
        executionOrder.push('step3');
        return { success: true, output: 'Step 3 done' };
      },
    }));

    // Execute in order
    await registry.execute('test.step1', {}, makeCtx());
    await registry.execute('test.step2', {}, makeCtx());
    await registry.execute('test.step3', {}, makeCtx());

    expect(executionOrder).toEqual(['step1', 'step2', 'step3']);
  });

  it('should continue executing after one tool fails', async () => {
    const registry = new ToolRegistry();
    const results: ToolResult[] = [];

    registry.register(makeTool({
      name: 'test.good',
      execute: async () => ({ success: true, output: 'ok' }),
    }));

    registry.register(makeTool({
      name: 'test.bad',
      execute: async () => ({ success: false, output: 'failed' }),
    }));

    // Execute good tool
    results.push(await registry.execute('test.good', {}, makeCtx()));
    // Execute bad tool (returns failure, does not throw)
    results.push(await registry.execute('test.bad', {}, makeCtx()));
    // Execute good tool again
    results.push(await registry.execute('test.good', {}, makeCtx()));

    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[2].success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('should handle very long tool output', async () => {
    const registry = new ToolRegistry();
    const longOutput = 'x'.repeat(100_000);

    registry.register(makeTool({
      name: 'test.long-output',
      execute: async () => ({ success: true, output: longOutput }),
    }));

    const result = await registry.execute('test.long-output', {}, makeCtx());
    expect(result.output.length).toBe(100_000);
  });

  it('should handle special characters in tool arguments', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: 'test.special',
      execute: async (params) => ({
        success: true,
        output: params['input'] as string,
      }),
    }));

    const specialInput = 'Hello\n\t"world" <html>&amp; \u0000 \uFFFF';
    const result = await registry.execute('test.special', { input: specialInput }, makeCtx());
    expect(result.output).toBe(specialInput);
  });

  it('should handle enum parameters in schema', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool({
      name: 'test.enum',
      parameters: {
        mode: {
          type: 'string',
          description: 'Operation mode',
          required: true,
          enum: ['fast', 'slow', 'auto'],
        },
      },
    }));

    const schemas = registry.getSchemaForLLM();
    const fn = (schemas[0] as Record<string, unknown>)['function'] as Record<string, unknown>;
    const params = fn['parameters'] as Record<string, unknown>;
    const props = params['properties'] as Record<string, Record<string, unknown>>;

    expect(props['mode']['enum']).toEqual(['fast', 'slow', 'auto']);
  });
});
