/**
 * @file slim-heartbeat-loop.test.ts
 * @description AgentLoop-level tests for the slim heartbeat context:
 *
 *  SHL-1  run(opts.slimHeartbeat) → brain.call gets promptMode 'slim-heartbeat'
 *         and ONLY tools from the slim allowlist
 *  SHL-2  a normal run (no opts) → no promptMode, full routing
 *  SHL-3  allowlist resolves 0 tools (registry lacks them) → fail-open:
 *         no promptMode, full routing
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { SLIM_HEARTBEAT_TOOLS } from '../../src/core/cron/slim-heartbeat.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainResponse } from '../../src/core/brain/types.js';

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});

function stop(): BrainResponse {
  return {
    content: 'HEARTBEAT_OK',
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'xai/grok-3-fast',
    finishReason: 'stop',
  };
}

/** Schema for a named tool in the registry's OpenAI-compatible LLM format. */
function schemaFor(name: string) {
  return {
    type: 'function' as const,
    function: { name, description: `mock ${name}`, parameters: { type: 'object', properties: {} } },
  };
}

function makeLoop(schemas: ReturnType<typeof schemaFor>[]) {
  const brain = createMockBrain();
  brain.call.mockResolvedValue(stop());
  const registry = createMockToolRegistry();
  registry.getSchemaForLLM = vi.fn(() => schemas) as typeof registry.getSchemaForLLM;
  const loop = new AgentLoop(
    brain, registry, createMockSessionManager(),
    undefined, undefined, undefined, undefined, undefined,
    createMockSandboxManager(),
  );
  return { brain, loop };
}

function firstCallRequest(brain: ReturnType<typeof createMockBrain>): Record<string, unknown> {
  return (brain.call.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
}

function toolNames(req: Record<string, unknown>): string[] {
  const tools = (req['tools'] ?? []) as Array<{ function?: { name?: string } }>;
  return tools.map((t) => t.function?.name ?? '');
}

describe('AgentLoop slim heartbeat context', () => {
  it('SHL-1: slimHeartbeat opt → promptMode slim-heartbeat + allowlist-only tools', async () => {
    // Registry exposes the slim allowlist plus unrelated tools.
    const schemas = [...SLIM_HEARTBEAT_TOOLS.map(schemaFor), schemaFor('media.image'), schemaFor('browser.navigate')];
    const { brain, loop } = makeLoop(schemas);

    await loop.run('test-session-id', '[HEARTBEAT] tick', undefined, { slimHeartbeat: true });

    const req = firstCallRequest(brain);
    expect(req['promptMode']).toBe('slim-heartbeat');
    const names = toolNames(req);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(SLIM_HEARTBEAT_TOOLS).toContain(n);
    expect(names).not.toContain('media.image');
    expect(names).not.toContain('browser.navigate');
  });

  it('SHL-2: normal run → no promptMode (full loadout)', async () => {
    const schemas = [...SLIM_HEARTBEAT_TOOLS.map(schemaFor), schemaFor('media.image')];
    const { brain, loop } = makeLoop(schemas);

    await loop.run('test-session-id', 'hello there');

    const req = firstCallRequest(brain);
    expect(req['promptMode']).toBeUndefined();
  });

  it('SHL-3: allowlist resolves 0 tools → fail-open to full routing, no promptMode', async () => {
    // Registry knows NONE of the slim allowlist tools.
    const { brain, loop } = makeLoop([schemaFor('media.image'), schemaFor('browser.navigate')]);

    await loop.run('test-session-id', '[HEARTBEAT] tick', undefined, { slimHeartbeat: true });

    const req = firstCallRequest(brain);
    expect(req['promptMode']).toBeUndefined();
  });
});
