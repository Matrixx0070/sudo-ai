/**
 * @file ship-completion-guard.test.ts
 * @description Deterministic completion guarantee for the change-cycle. A turn
 * that calls github.commit has declared intent to ship; if the run ends without
 * a successful github.open_pr, the change is committed-but-unshipped (or the
 * edits are stranded after an early "nothing to commit"). The loop re-enters
 * (capped) with a hard nudge to finish the PR. Observed live: rounds 6 & 11
 * wrote + committed work then stopped before opening a PR.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
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

function makeLoop(brain: ReturnType<typeof createMockBrain>, registry: ReturnType<typeof createMockToolRegistry>) {
  return new AgentLoop(
    brain,
    registry,
    createMockSessionManager(),
    undefined, undefined, undefined, undefined, undefined,
    createMockSandboxManager(),
  );
}

/** Registry whose github.open_pr result mimics a real success ("Opened PR #N") or failure. */
function ghRegistry(openPrSucceeds: boolean) {
  const reg = createMockToolRegistry();
  reg.execute.mockImplementation(async (name: string) => ({
    success: true,
    output:
      name === 'github.open_pr'
        ? (openPrSucceeds ? 'Opened PR #5: https://github.com/o/r/pull/5' : 'github.open_pr failed: push rejected')
        : `${name} ok`,
  }));
  return reg;
}

function toolCall(name: string, id: string): BrainResponse {
  return {
    content: 'working', toolCalls: [{ id, name, arguments: {} }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'xai/grok-3-fast', finishReason: 'tool-calls',
  };
}
function stop(content = 'done'): BrainResponse {
  return {
    content, toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'xai/grok-3-fast', finishReason: 'stop',
  };
}

/** Did the ship-incomplete nudge reach any brain.call (i.e. did the loop re-enter)? */
function nudgeReached(brain: ReturnType<typeof createMockBrain>): boolean {
  return brain.call.mock.calls.some((c) => {
    const msgs = ((c[0] as { messages?: Array<{ content: unknown }> })?.messages ?? []);
    return msgs.some((m) => typeof m.content === 'string' && m.content.includes('[Ship incomplete'));
  });
}

afterEach(() => { delete process.env['SUDO_SHIP_COMPLETION_GUARD']; });

describe('ship-completion guard', () => {
  it('re-enters when github.commit ran but no PR was opened', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValueOnce(toolCall('github.commit', 'c1'));
    brain.call.mockResolvedValue(stop('done'));
    await makeLoop(brain, ghRegistry(false)).run('test-session-id', 'ship a change');
    expect(nudgeReached(brain)).toBe(true);
  });

  it('does NOT re-enter when github.open_pr succeeds', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValueOnce(toolCall('github.commit', 'c1'));
    brain.call.mockResolvedValueOnce(toolCall('github.open_pr', 'p1'));
    brain.call.mockResolvedValue(stop('shipped'));
    await makeLoop(brain, ghRegistry(true)).run('test-session-id', 'ship a change');
    expect(nudgeReached(brain)).toBe(false);
  });

  it('does NOT re-enter for a turn that never called github.commit', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValueOnce(toolCall('coder.read-file', 'r1'));
    brain.call.mockResolvedValue(stop('done'));
    await makeLoop(brain, ghRegistry(false)).run('test-session-id', 'just read a file');
    expect(nudgeReached(brain)).toBe(false);
  });

  it('is disabled by SUDO_SHIP_COMPLETION_GUARD=0', async () => {
    process.env['SUDO_SHIP_COMPLETION_GUARD'] = '0';
    const brain = createMockBrain();
    brain.call.mockResolvedValueOnce(toolCall('github.commit', 'c1'));
    brain.call.mockResolvedValue(stop('done'));
    await makeLoop(brain, ghRegistry(false)).run('test-session-id', 'ship a change');
    expect(nudgeReached(brain)).toBe(false);
  });
});
