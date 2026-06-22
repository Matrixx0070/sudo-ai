/**
 * Regression for long-turn self-amnesia. In a turn with many tool calls, the
 * sliding window (WINDOW_SIZE=12 non-system) evicts the agent's OWN earlier
 * file edits, so it loses sight of work it already did and disowns it ("none of
 * those files exist / no change was made") then stops. Observed live: SUDO
 * edited src/core/shared/head-tail-buffer.ts, the edit was evicted across an
 * ~80-tool-call turn, and it concluded the task was unstarted.
 *
 * prepareMessages now digests the turn's file-mutating tool calls and injects a
 * "work you've already done this turn" anchor when the window drops messages.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { extractTurnMutations } from '../../src/core/agent/loop-helpers.js';
import {
  createMockBrain,
  createMockToolRegistry,
  createMockSessionManager,
} from '../helpers/mocks.js';
import type { BrainResponse } from '../../src/core/brain/types.js';

describe('extractTurnMutations', () => {
  const asst = (toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>) =>
    ({ role: 'assistant', toolCalls });

  it('captures file-mutating tools with their path, deduped', () => {
    const out = extractTurnMutations([
      asst([{ name: 'coder.write-file', arguments: { path: 'src/a.ts' } }]),
      asst([{ name: 'coder.smart-edit', arguments: { filePath: 'src/b.ts' } }]),
      asst([{ name: 'meta.self-modify', arguments: { action: 'edit-file', path: 'src/c.ts' } }]),
      asst([{ name: 'coder.write-file', arguments: { path: 'src/a.ts' } }]), // dup
    ]);
    expect(out).toHaveLength(3);
    expect(out.join('\n')).toContain('src/a.ts');
    expect(out.join('\n')).toContain('src/b.ts (coder.smart-edit)');
    expect(out.join('\n')).toContain('src/c.ts (meta.self-modify edit-file)');
  });

  it('ignores read-only / non-mutating tools', () => {
    const out = extractTurnMutations([
      asst([{ name: 'coder.read-file', arguments: { path: 'src/a.ts' } }]),
      asst([{ name: 'coder.grep', arguments: { pattern: 'x' } }]),
      asst([{ name: 'meta.self-modify', arguments: { action: 'read-file', path: 'src/b.ts' } }]),
      { role: 'tool', toolCalls: undefined },
    ]);
    expect(out).toEqual([]);
  });
});

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

function toolCall(name: string, id: string, args: Record<string, unknown> = {}): BrainResponse {
  return {
    content: 'working',
    toolCalls: [{ id, name, arguments: args }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'xai/grok-3-fast',
    finishReason: 'tool-calls',
  };
}
function stop(content = 'done'): BrainResponse {
  return {
    content, toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'xai/grok-3-fast', finishReason: 'stop',
  };
}

describe('long-turn work anchor — prepareMessages', () => {
  it('surfaces an evicted file edit so the agent does not disown it', async () => {
    const brain = createMockBrain();
    // First action edits a file, then 7 more distinct tool rounds push the edit
    // out of the 12-message window (8 rounds => 16 non-system + user = 17).
    brain.call.mockResolvedValueOnce(toolCall('coder.write-file', 'tc-w', { path: 'src/core/shared/head-tail-buffer.ts' }));
    for (let i = 0; i < 7; i++) {
      brain.call.mockResolvedValueOnce(toolCall(`system.step${i}`, `tc-${i}`));
    }
    brain.call.mockResolvedValue(stop('done'));

    await makeLoop(brain).run('test-session-id', 'improve the head-tail buffer');

    const calls = brain.call.mock.calls;
    const lastMsgs = ((calls[calls.length - 1]?.[0] as { messages?: Array<{ content: unknown }> })?.messages ?? []);
    const blob = lastMsgs
      .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    // The anchor names the evicted edit and tells the model not to disown it.
    expect(blob).toContain('head-tail-buffer.ts');
    expect(blob).toContain('ALREADY done');
  });
});
