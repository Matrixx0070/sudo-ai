/**
 * Blockers #2+#3 from the 2026-08-05 autonomy audit. A spend-cap halt used the
 * LoopGuard's "stuck in a loop" fallback, so the agent misreported its own stop
 * cause to the user (live: 38 recon iterations, $5.12/$5.00, reported a tool
 * loop). Halts must carry a structured reason into the reply and leave a
 * durable resume note; every iteration must surface the run budget.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { buildRunHaltReply, runHaltNotice } from '../../src/core/agent/loop-fallback.js';
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

function makeLoop(brain: ReturnType<typeof createMockBrain>) {
  return new AgentLoop(
    brain,
    createMockToolRegistry(),
    createMockSessionManager(),
    undefined, undefined, undefined, undefined, undefined,
    createMockSandboxManager(),
  );
}

function costlyToolCall(i: number): BrainResponse {
  return {
    content: 'recon in progress',
    toolCalls: [{ id: `tc-${i}`, name: `system.step${i}`, arguments: {} }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 1 },
    model: 'xai/grok-3-fast',
    finishReason: 'tool-calls',
  };
}

describe('buildRunHaltReply / runHaltNotice', () => {
  it('names the spend cap with amounts and iterations, never "stuck"', () => {
    const txt = buildRunHaltReply({ kind: 'spend_cap', spendUsd: 5.12, capUsd: 5, iterations: 38 });
    expect(txt).toContain('spend cap ($5.12 of $5.00) after 38 iterations');
    expect(txt).not.toMatch(/stuck in a loop/i);
  });
  it('names the iteration limit', () => {
    expect(buildRunHaltReply({ kind: 'max_iterations', iterations: 150 })).toContain('iteration limit (150)');
  });
  it('notice is short and names the cause', () => {
    expect(runHaltNotice({ kind: 'spend_cap', spendUsd: 5.12, capUsd: 5, iterations: 38 })).toContain('spend cap $5.12/$5.00');
  });
});

describe('spend-cap halt end-to-end', () => {
  afterEach(() => { delete process.env['SUDO_AGENT_RUN_MAX_USD']; });

  it('reports the spend cap honestly and leaves a durable resume note', async () => {
    process.env['SUDO_AGENT_RUN_MAX_USD'] = '0.5';
    const brain = createMockBrain();
    for (let i = 0; i < 5; i++) brain.call.mockResolvedValueOnce(costlyToolCall(i));
    brain.call.mockResolvedValue(costlyToolCall(99));

    const loop = makeLoop(brain);
    const final = await loop.run('test-session-id', 'do a big recon');

    expect((final as unknown as { text: string }).text).toContain('Run halted early: spend cap');
    expect((final as unknown as { text: string }).text).not.toMatch(/stuck in a loop/i);
  });

  it('every brain call carries an ephemeral [Run status] budget line', async () => {
    process.env['SUDO_AGENT_RUN_MAX_USD'] = '0.5';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(costlyToolCall(0));
    await makeLoop(brain).run('test-session-id', 'go');

    const firstCallMsgs = (brain.call.mock.calls[0]?.[0] as { messages?: Array<{ role: string; content: string }> })?.messages ?? [];
    const statusLines = firstCallMsgs.filter(m => m.role === 'system' && String(m.content).startsWith('[Run status]'));
    expect(statusLines).toHaveLength(1);
    expect(statusLines[0]!.content).toContain('$0.00 of $0.50 cap');
  });
});
