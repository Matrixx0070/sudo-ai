/**
 * Policy-denial escalation (first eval-sandbox finding, ADR-0007):
 * a policy denial is not a transient error — retrying the same tool cannot
 * succeed. Live `unreliable-service` runs showed the agent retrying a
 * policy-denied system.exec and never switching to system.api-call.
 *
 *   1st denial of a tool in a turn → system-style nudge injected.
 *   2nd denial of the SAME tool     → tool removed from the schema presented
 *                                     on subsequent iterations (turn-scoped).
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { isPolicyDenial, TurnPolicyDenialTracker } from '../../src/core/agent/policy-denial.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainRequest, BrainResponse } from '../../src/core/brain/types.js';

// ---------------------------------------------------------------------------
// Unit: denial detector
// ---------------------------------------------------------------------------

describe('isPolicyDenial', () => {
  it('recognizes the eval-sandbox gate denial', () => {
    expect(isPolicyDenial("eval-policy: tool 'system.exec' is denied by scenario policy (unreliable-service)")).toBe(true);
  });

  it('recognizes the eval denial with a prepended annotation line', () => {
    expect(isPolicyDenial("[Prevention hint] avoid shell here\n\neval-policy: tool 'system.exec' is denied")).toBe(true);
  });

  it('recognizes the plan-mode gate denial wrapped as an execution error', () => {
    expect(isPolicyDenial(
      "Error executing tool file.write: ToolError: Plan mode active (draft) — destructive tool 'file.write' is blocked until the plan is approved",
    )).toBe(true);
  });

  it('recognizes the PermissionManager permanent deny', () => {
    expect(isPolicyDenial('[PermissionManager] Tool execution permanently denied: system.exec')).toBe(true);
  });

  it('does NOT flag interactive user denials (user may approve later)', () => {
    expect(isPolicyDenial('Tool execution denied by user: system.exec')).toBe(false);
  });

  it('does NOT flag ordinary tool errors', () => {
    expect(isPolicyDenial('Error executing tool system.exec: Command exited with code 127')).toBe(false);
    expect(isPolicyDenial('fetch failed: ECONNREFUSED')).toBe(false);
  });

  it('does NOT flag a mid-line mention of the eval prefix', () => {
    expect(isPolicyDenial('the gate returns eval-policy: denials on blocked tools')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: turn-scoped tracker escalation
// ---------------------------------------------------------------------------

describe('TurnPolicyDenialTracker', () => {
  it('escalates nudge → remove → already-removed per tool', () => {
    const t = new TurnPolicyDenialTracker();
    expect(t.record('system.exec')).toBe('nudge');
    expect(t.record('system.exec')).toBe('remove');
    expect(t.record('system.exec')).toBe('already-removed');
    expect(t.getCount('system.exec')).toBe(3);
    expect([...t.removedTools]).toEqual(['system.exec']);
  });

  it('tracks tools independently', () => {
    const t = new TurnPolicyDenialTracker();
    expect(t.record('system.exec')).toBe('nudge');
    expect(t.record('file.write')).toBe('nudge');
    expect(t.removedTools.size).toBe(0);
    expect(t.record('file.write')).toBe('remove');
    expect(t.removedTools.has('file.write')).toBe(true);
    expect(t.removedTools.has('system.exec')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: loop nudge + turn-scoped schema removal
// ---------------------------------------------------------------------------

const EXEC_SCHEMA = {
  type: 'function' as const,
  function: { name: 'system.exec', description: 'run a shell command', parameters: { type: 'object', properties: {} } },
};
const API_SCHEMA = {
  type: 'function' as const,
  function: { name: 'system.api-call', description: 'make an http request', parameters: { type: 'object', properties: {} } },
};

const createMockSandboxManager = () => ({
  getWorkspaceDir: vi.fn().mockReturnValue('/mock/workspace'),
  getPolicyFor: vi.fn().mockReturnValue({}),
});

function makeDenialLoop() {
  const registry = createMockToolRegistry();
  registry.getSchemaForLLM = vi.fn(() => [EXEC_SCHEMA, API_SCHEMA]) as never;
  registry.execute.mockImplementation(async (name: string) => {
    if (name === 'system.exec') {
      return { success: false, output: "eval-policy: tool 'system.exec' is denied by scenario policy (unreliable-service)", data: {} };
    }
    return { success: true, output: 'HTTP 200 OK', data: {} };
  });
  const brain = createMockBrain();
  const loop = new AgentLoop(
    brain, registry, createMockSessionManager(),
    { maxIterations: 6 }, undefined, undefined, undefined, undefined,
    createMockSandboxManager(),
  );
  return { brain, registry, loop };
}

/** Brain that retries the denied tool, then stops; captures each request. */
function retryingBrain(brain: ReturnType<typeof createMockBrain>, requests: BrainRequest[]) {
  let n = 0;
  brain.call.mockImplementation(async (req: BrainRequest): Promise<BrainResponse> => {
    requests.push(req);
    n++;
    if (n <= 2) {
      return {
        content: '',
        // vary args so LoopGuard/DoomLoop (which key on tool+args) stay quiet —
        // this test isolates the result-aware policy-denial path.
        toolCalls: [{ id: `tc-${n}`, name: 'system.exec', arguments: { cmd: `curl -s x${n}` } }],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
        model: 'test-model',
        finishReason: 'tool-calls',
      } as BrainResponse;
    }
    return {
      content: 'switched tools and finished',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
      model: 'test-model',
      finishReason: 'stop',
    } as BrainResponse;
  });
}

const toolNames = (req: BrainRequest): string[] =>
  ((req as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []).map((t) => t.function?.name ?? '');

describe('agent loop policy-denial escalation', () => {
  it('injects a nudge after the first denial and removes the tool from the schema after the second', async () => {
    const { brain, loop } = makeDenialLoop();
    const requests: BrainRequest[] = [];
    retryingBrain(brain, requests);

    const result = await loop.run('test-session-id', 'fetch the url with a shell command');
    expect(result.text).toBe('switched tools and finished');
    expect(requests.length).toBe(3);

    // Request 2 (after 1st denial): nudge present, tool still offered (1 probe allowed).
    const req2Contents = requests[1]!.messages.map((m) => String((m as { content?: unknown }).content ?? ''));
    expect(req2Contents.some((c) => c.includes("[PolicyDenial] Tool 'system.exec' is unavailable by policy"))).toBe(true);
    expect(toolNames(requests[1]!)).toContain('system.exec');

    // Request 3 (after 2nd denial): tool REMOVED from the presented schema.
    expect(toolNames(requests[2]!)).not.toContain('system.exec');
    const req3Contents = requests[2]!.messages.map((m) => String((m as { content?: unknown }).content ?? ''));
    expect(req3Contents.some((c) => c.includes('denied by policy twice this turn'))).toBe(true);
  });

  it('removal is turn-scoped — a fresh run offers the tool again', async () => {
    const { brain, loop } = makeDenialLoop();
    const requests: BrainRequest[] = [];
    retryingBrain(brain, requests);
    await loop.run('test-session-id', 'fetch the url with a shell command');
    expect(toolNames(requests[2]!)).not.toContain('system.exec');

    // Second turn: schema restored (nothing persisted).
    const requests2: BrainRequest[] = [];
    brain.call.mockImplementation(async (req: BrainRequest): Promise<BrainResponse> => {
      requests2.push(req);
      return {
        content: 'ok', toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCost: 0 },
        model: 'test-model', finishReason: 'stop',
      } as BrainResponse;
    });
    await loop.run('test-session-id', 'run a shell command');
    expect(toolNames(requests2[0]!)).toContain('system.exec');
  });

  it('an ordinary tool error does not trigger nudge or removal', async () => {
    const registry = createMockToolRegistry();
    registry.getSchemaForLLM = vi.fn(() => [EXEC_SCHEMA, API_SCHEMA]) as never;
    registry.execute.mockResolvedValue({ success: false, output: 'Error: connection reset', data: {} });
    const brain = createMockBrain();
    const requests: BrainRequest[] = [];
    retryingBrain(brain, requests);
    const loop = new AgentLoop(
      brain, registry, createMockSessionManager(),
      { maxIterations: 6 }, undefined, undefined, undefined, undefined,
      createMockSandboxManager(),
    );
    await loop.run('test-session-id', 'fetch the url with a shell command');
    expect(requests.length).toBe(3);
    expect(toolNames(requests[2]!)).toContain('system.exec');
    const allContents = requests[2]!.messages.map((m) => String((m as { content?: unknown }).content ?? ''));
    expect(allContents.some((c) => c.includes('[PolicyDenial]'))).toBe(false);
  });
});
