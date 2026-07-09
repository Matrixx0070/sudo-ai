/**
 * Tests for declared-boolean argument coercion in the tool registry.
 *
 * Live-observed bug class: the model emitted {"dryRun": "false"} (string) for
 * a declared type:'boolean' parameter; `params['dryRun'] !== false` then held
 * true for the STRING, so skill.install ran four times all forced into
 * dryRun mode. The registry now coerces exactly "true"/"false" strings on
 * declared-boolean params before execution.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry, coerceDeclaredBooleans } from '../../src/core/tools/registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../src/core/tools/types.js';

const ctx = { sessionId: 'test-session' } as ToolContext;

function probeTool(received: { params?: Record<string, unknown> }): ToolDefinition {
  return {
    name: 'test.bool-probe',
    description: 'records received params',
    category: 'meta' as ToolDefinition['category'],
    parameters: {
      dryRun: { type: 'boolean', description: 'declared boolean', default: true },
      label: { type: 'string', description: 'declared string' },
    },
    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      received.params = params;
      return { success: true, output: 'ok', data: {} };
    },
  };
}

describe('coerceDeclaredBooleans (unit)', () => {
  const tool = { parameters: { dryRun: { type: 'boolean' as const, description: '' } } };

  it('converts "false"/"true" strings on declared-boolean params', () => {
    expect(coerceDeclaredBooleans(tool, { dryRun: 'false' })['dryRun']).toBe(false);
    expect(coerceDeclaredBooleans(tool, { dryRun: 'true' })['dryRun']).toBe(true);
  });

  it('passes native booleans and unrelated values through untouched', () => {
    expect(coerceDeclaredBooleans(tool, { dryRun: false })['dryRun']).toBe(false);
    expect(coerceDeclaredBooleans(tool, { dryRun: true })['dryRun']).toBe(true);
    expect(coerceDeclaredBooleans(tool, { dryRun: 'FALSE' })['dryRun']).toBe('FALSE');
    expect(coerceDeclaredBooleans(tool, {})['dryRun']).toBeUndefined();
  });

  it('does not touch string-typed params and does not mutate the input', () => {
    const t = { parameters: { label: { type: 'string' as const, description: '' } } };
    const input = { label: 'false' };
    const out = coerceDeclaredBooleans(t, input);
    expect(out['label']).toBe('false');
    expect(out).toBe(input); // no copy when nothing coerced
    const t2 = { parameters: { dryRun: { type: 'boolean' as const, description: '' } } };
    const input2 = { dryRun: 'false' };
    const out2 = coerceDeclaredBooleans(t2, input2);
    expect(input2.dryRun).toBe('false'); // original untouched
    expect(out2).not.toBe(input2);
  });
});

describe('registry.execute applies boolean coercion', () => {
  it('tool receives a real boolean when the model sent a string', async () => {
    const received: { params?: Record<string, unknown> } = {};
    const registry = new ToolRegistry();
    registry.register(probeTool(received));
    await registry.execute('test.bool-probe', { dryRun: 'false', label: 'false' }, ctx);
    expect(received.params?.['dryRun']).toBe(false);
    expect(received.params?.['label']).toBe('false'); // string param untouched
  });
});
