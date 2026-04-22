/**
 * Unit tests for ToolRegistry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/core/tools/registry.js';
import { ToolError } from '../../../src/core/shared/errors.js';
import type { ToolDefinition, ToolResult } from '../../../src/core/tools/types.js';
import { makeToolDefinition, makeToolContext } from '../../helpers/mocks.js';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // -------------------------------------------------------------------------
  // register()
  // -------------------------------------------------------------------------

  it('registers a tool and reports size = 1', () => {
    registry.register(makeToolDefinition('system.hello'));
    expect(registry.size).toBe(1);
  });

  it('registered tool appears in listAll()', () => {
    const tool = makeToolDefinition('system.hello');
    registry.register(tool);
    const all = registry.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('system.hello');
  });

  it('registered tool appears in listEnabled()', () => {
    registry.register(makeToolDefinition('system.hello'));
    expect(registry.listEnabled()).toHaveLength(1);
  });

  it('throws ToolError when registering a tool with empty name', () => {
    const bad = { name: '', description: 'bad', category: 'system', parameters: {}, execute: vi.fn() } as unknown as ToolDefinition;
    expect(() => registry.register(bad)).toThrow(ToolError);
  });

  it('throws ToolError when registering a tool without execute function', () => {
    const bad = { name: 'no.execute', description: 'd', category: 'system', parameters: {} } as unknown as ToolDefinition;
    expect(() => registry.register(bad)).toThrow(ToolError);
    expect(() => registry.register(bad)).toThrow(/execute function/);
  });

  it('overwrites existing registration with the same name (no throw)', () => {
    const tool1 = makeToolDefinition('system.hello');
    const tool2 = makeToolDefinition('system.hello');
    registry.register(tool1);
    registry.register(tool2); // should overwrite, not throw
    expect(registry.size).toBe(1);
  });

  // -------------------------------------------------------------------------
  // registerMany()
  // -------------------------------------------------------------------------

  it('registers multiple tools in one call', () => {
    const tools = [
      makeToolDefinition('system.a'),
      makeToolDefinition('system.b'),
      makeToolDefinition('coder.c'),
    ];
    registry.registerMany(tools);
    expect(registry.size).toBe(3);
  });

  it('throws ToolError when registerMany receives a non-array', () => {
    expect(() => registry.registerMany('not-array' as unknown as ToolDefinition[])).toThrow(ToolError);
  });

  // -------------------------------------------------------------------------
  // unregister()
  // -------------------------------------------------------------------------

  it('removes a tool via unregister()', () => {
    registry.register(makeToolDefinition('system.hello'));
    registry.unregister('system.hello');
    expect(registry.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // get()
  // -------------------------------------------------------------------------

  it('returns the tool by name', () => {
    const tool = makeToolDefinition('system.hello');
    registry.register(tool);
    expect(registry.get('system.hello')).toBe(tool);
  });

  it('returns undefined for an unregistered tool name', () => {
    expect(registry.get('does.not.exist')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // disable() / enable() / isEnabled()
  // -------------------------------------------------------------------------

  it('disabled tool is not in listEnabled()', () => {
    registry.register(makeToolDefinition('system.hello'));
    registry.disable('system.hello');
    expect(registry.listEnabled()).toHaveLength(0);
  });

  it('disabled tool is still in listAll()', () => {
    registry.register(makeToolDefinition('system.hello'));
    registry.disable('system.hello');
    expect(registry.listAll()).toHaveLength(1);
  });

  it('isEnabled() returns false for disabled tool', () => {
    registry.register(makeToolDefinition('system.hello'));
    registry.disable('system.hello');
    expect(registry.isEnabled('system.hello')).toBe(false);
  });

  it('isEnabled() returns true after re-enabling', () => {
    registry.register(makeToolDefinition('system.hello'));
    registry.disable('system.hello');
    registry.enable('system.hello');
    expect(registry.isEnabled('system.hello')).toBe(true);
  });

  it('isEnabled() returns false for unregistered tool', () => {
    expect(registry.isEnabled('never.registered')).toBe(false);
  });

  it('enabledSize reflects disable state', () => {
    registry.register(makeToolDefinition('system.a'));
    registry.register(makeToolDefinition('system.b'));
    registry.disable('system.a');
    expect(registry.enabledSize).toBe(1);
  });

  // -------------------------------------------------------------------------
  // execute() — success
  // -------------------------------------------------------------------------

  it('executes a registered tool and returns ToolResult', async () => {
    const expected: ToolResult = { success: true, output: 'done' };
    const tool = makeToolDefinition('system.hello', 'system', expected);
    registry.register(tool);

    const ctx = makeToolContext();
    const result = await registry.execute('system.hello', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBe('done');
  });

  it('passes params to the execute function', async () => {
    let receivedParams: Record<string, unknown> = {};
    const tool: ToolDefinition = {
      name: 'system.echo',
      description: 'echo',
      category: 'system',
      parameters: {},
      execute: async (params) => {
        receivedParams = params;
        return { success: true, output: 'echoed' };
      },
    };
    registry.register(tool);

    await registry.execute('system.echo', { message: 'hello' }, makeToolContext());
    expect(receivedParams['message']).toBe('hello');
  });

  // -------------------------------------------------------------------------
  // execute() — error paths
  // -------------------------------------------------------------------------

  it('throws ToolError with code tool_not_found for unknown tool', async () => {
    const ctx = makeToolContext();
    await expect(registry.execute('does.not.exist', {}, ctx)).rejects.toThrow(ToolError);
    await expect(registry.execute('does.not.exist', {}, ctx)).rejects.toThrow(/Tool not found/);
  });

  it('throws ToolError with code tool_disabled for disabled tool', async () => {
    registry.register(makeToolDefinition('system.hello'));
    registry.disable('system.hello');
    const ctx = makeToolContext();
    await expect(registry.execute('system.hello', {}, ctx)).rejects.toThrow(ToolError);
    try {
      await registry.execute('system.hello', {}, ctx);
    } catch (e) {
      expect((e as ToolError).code).toBe('tool_disabled');
    }
  });

  it('throws ToolError with code tool_aborted when upstream signal is already aborted', async () => {
    registry.register(makeToolDefinition('system.hello'));
    const controller = new AbortController();
    controller.abort();
    const ctx = makeToolContext({ signal: controller.signal });
    await expect(registry.execute('system.hello', {}, ctx)).rejects.toThrow(ToolError);
    try {
      await registry.execute('system.hello', {}, ctx);
    } catch (e) {
      expect((e as ToolError).code).toBe('tool_aborted');
    }
  });

  // -------------------------------------------------------------------------
  // executeCall()
  // -------------------------------------------------------------------------

  it('executeCall returns ToolCallResult with toolCallId and durationMs', async () => {
    registry.register(makeToolDefinition('system.hello'));
    const result = await registry.executeCall(
      { id: 'call-abc', name: 'system.hello', arguments: {} },
      makeToolContext(),
    );
    expect(result.toolCallId).toBe('call-abc');
    expect(result.name).toBe('system.hello');
    expect(typeof result.durationMs).toBe('number');
    expect(result.result.success).toBe(true);
  });

  it('executeCall throws ToolError when call has no id', async () => {
    await expect(
      registry.executeCall({ id: '', name: 'system.hello', arguments: {} }, makeToolContext()),
    ).rejects.toThrow(ToolError);
  });

  it('executeCall throws ToolError when call has no name', async () => {
    await expect(
      registry.executeCall({ id: 'some-id', name: '', arguments: {} }, makeToolContext()),
    ).rejects.toThrow(ToolError);
  });

  // -------------------------------------------------------------------------
  // getSchemaForLLM()
  // -------------------------------------------------------------------------

  it('getSchemaForLLM returns array of OpenAI-compatible function schemas', () => {
    registry.register(makeToolDefinition('system.hello'));
    const schemas = registry.getSchemaForLLM();
    expect(Array.isArray(schemas)).toBe(true);
    expect(schemas).toHaveLength(1);
    const schema = schemas[0] as { type: string; function: { name: string } };
    expect(schema.type).toBe('function');
    expect(schema.function.name).toBe('system.hello');
  });

  it('getSchemaForLLM excludes disabled tools', () => {
    registry.register(makeToolDefinition('system.a'));
    registry.register(makeToolDefinition('system.b'));
    registry.disable('system.a');
    const schemas = registry.getSchemaForLLM();
    expect(schemas).toHaveLength(1);
    const s = schemas[0] as { function: { name: string } };
    expect(s.function.name).toBe('system.b');
  });

  // -------------------------------------------------------------------------
  // getByCategory()
  // -------------------------------------------------------------------------

  it('getByCategory returns only tools in that category', () => {
    registry.register(makeToolDefinition('system.a', 'system'));
    registry.register(makeToolDefinition('coder.b', 'coder'));
    registry.register(makeToolDefinition('coder.c', 'coder'));

    const coderTools = registry.getByCategory('coder');
    expect(coderTools).toHaveLength(2);
    expect(coderTools.every((t) => t.category === 'coder')).toBe(true);
  });

  it('getByCategory returns empty array when no tools match', () => {
    registry.register(makeToolDefinition('system.a', 'system'));
    expect(registry.getByCategory('browser')).toHaveLength(0);
  });
});
