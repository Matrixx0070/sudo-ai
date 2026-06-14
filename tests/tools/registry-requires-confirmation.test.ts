/**
 * Gap #20 verifier BLOCKER regression guard — `ToolRegistry` must expose
 * `requiresConfirmation(name)` because `loop-helpers.ts:675` calls it
 * duck-typed and short-circuits silently when the method is absent.
 * Without this method, every `requiresConfirmation: true` tool in the
 * codebase was executed without a user prompt.
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolDefinition } from '../../src/core/tools/types.js';

function makeTool(name: string, requiresConfirmation: boolean): ToolDefinition {
  return {
    name,
    description: name,
    category: 'meta' as const,
    requiresConfirmation,
    timeout: 1_000,
    parameters: {},
    async execute() {
      return { success: true, output: '', data: {} };
    },
  };
}

describe('ToolRegistry.requiresConfirmation', () => {
  it('reflects the tool definition flag', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('writes.file', true));
    reg.register(makeTool('reads.file', false));
    expect(reg.requiresConfirmation('writes.file')).toBe(true);
    expect(reg.requiresConfirmation('reads.file')).toBe(false);
  });

  it('returns false for unknown tool names', () => {
    const reg = new ToolRegistry();
    expect(reg.requiresConfirmation('nope.no.exist')).toBe(false);
    expect(reg.requiresConfirmation('')).toBe(false);
  });

  it('returns false for disabled tools (the gate skips them entirely)', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('writes.file', true));
    reg.disable('writes.file');
    expect(reg.requiresConfirmation('writes.file')).toBe(false);
  });
});
