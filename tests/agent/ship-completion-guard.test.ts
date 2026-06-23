/**
 * @file ship-completion-guard.test.ts
 * @description Deterministic completion guarantee for the change-cycle. Two
 * failure modes end a run with the change unshipped; the loop re-enters (capped)
 * with a hard nudge:
 *   A. commit-without-PR — github.commit ran but no successful github.open_pr
 *      (rounds 6 & 11: wrote + committed work, then stopped).
 *   B. edit-without-commit — edited src/ or tests/ code but never committed or
 *      opened a PR, and it was not a self-deploy (rounds 14-16: wrote a real
 *      change, verified it, then stopped before shipping). A self-deploy
 *      (meta.self-modify restart/full-cycle) needs no PR and is excluded;
 *      workspace/memory edits are out of scope (not src/tests).
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
  return toolCallArgs(name, id, {});
}
/** A tool-call turn carrying arguments (path/action) — needed for trigger-B detection,
 *  which reads the assistant tool CALL arguments, not the result string. */
function toolCallArgs(name: string, id: string, args: Record<string, unknown>): BrainResponse {
  return {
    content: 'working', toolCalls: [{ id, name, arguments: args }],
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

describe('ship-completion guard — B: edit-without-commit', () => {
  it('re-enters when a tests/ file was edited but never committed', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValueOnce(
      toolCallArgs('meta.self-modify', 'e1', { action: 'write-file', path: 'tests/agent/paths.test.ts' }),
    );
    brain.call.mockResolvedValue(stop('done — wrote a test'));
    await makeLoop(brain, ghRegistry(false)).run('test-session-id', 'add a test');
    expect(nudgeReached(brain)).toBe(true);
  });

  it('re-enters when a src/ file was edited via coder.write-file but never committed', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValueOnce(
      toolCallArgs('coder.write-file', 'e1', { path: 'src/core/foo.ts' }),
    );
    brain.call.mockResolvedValue(stop('done'));
    await makeLoop(brain, ghRegistry(false)).run('test-session-id', 'edit a module');
    expect(nudgeReached(brain)).toBe(true);
  });

  it('does NOT re-enter for a self-deploy (full-cycle) of an edited src file', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValueOnce(
      toolCallArgs('meta.self-modify', 'e1', { action: 'write-file', path: 'src/core/foo.ts' }),
    );
    brain.call.mockResolvedValueOnce(
      toolCallArgs('meta.self-modify', 'd1', { action: 'full-cycle' }),
    );
    brain.call.mockResolvedValue(stop('deployed live'));
    await makeLoop(brain, ghRegistry(false)).run('test-session-id', 'fix and deploy a live bug');
    expect(nudgeReached(brain)).toBe(false);
  });

  it('does NOT re-enter for a workspace/memory edit (not src/tests)', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValueOnce(
      toolCallArgs('meta.self-modify', 'e1', { action: 'write-file', path: 'workspace/memory/2026-06-23.md' }),
    );
    brain.call.mockResolvedValue(stop('noted'));
    await makeLoop(brain, ghRegistry(false)).run('test-session-id', 'jot a note');
    expect(nudgeReached(brain)).toBe(false);
  });

  it('does NOT re-enter when the edited change is shipped (edit → commit → PR)', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValueOnce(
      toolCallArgs('coder.write-file', 'e1', { path: 'src/core/foo.ts' }),
    );
    brain.call.mockResolvedValueOnce(toolCall('github.commit', 'c1'));
    brain.call.mockResolvedValueOnce(toolCall('github.open_pr', 'p1'));
    brain.call.mockResolvedValue(stop('shipped'));
    await makeLoop(brain, ghRegistry(true)).run('test-session-id', 'edit and ship');
    expect(nudgeReached(brain)).toBe(false);
  });
});
