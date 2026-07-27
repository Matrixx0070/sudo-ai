/**
 * @file al1-loop-invariants.test.ts
 * @description AL1.1 loop invariants (docs/OPUS_HANDOFF_AGENTIC_LADDER.md) —
 * the audit-identified gaps only; invariants already proven elsewhere are not
 * duplicated (compaction goal-pin → compaction-pin-goal.test.ts, empty-reply
 * normalization → channels/empty-reply.test.ts):
 *   (a) a THROWING tool's error re-enters the loop as an observation and the
 *       loop continues — never a swallowed error, never a crashed turn;
 *   (b) doom-loop stays silent on retry-with-CHANGED-args (the legitimate
 *       pattern) while still firing on identical repeats;
 *   (d) the max-iterations stop condition halts with a typed, reportable
 *       error naming the limit.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/core/agent/loop.js';
import { PipelineError } from '../../src/core/shared/errors.js';
import {
  DoomLoopDetector,
  DOOM_LOOP_THRESHOLD,
  DOOM_LOOP_RO_THRESHOLD,
} from '../../src/core/agent/doom-loop.js';
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

function toolCallResponse(toolName: string, args: Record<string, unknown> = {}): BrainResponse {
  return {
    content: '',
    toolCalls: [{ id: `call-${Math.random().toString(36).slice(2, 8)}`, name: toolName, arguments: args }],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'mock/model',
    finishReason: 'tool-calls',
  };
}

function stopResponse(content = 'done'): BrainResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 },
    model: 'mock/model',
    finishReason: 'stop',
  };
}

describe('AL1.1(a) — throwing tool error re-enters the loop as observation', () => {
  it('emits a failed tool-result carrying the error string and the loop continues to completion', async () => {
    const brain = createMockBrain();
    const tools = createMockToolRegistry();
    const sessions = createMockSessionManager();
    const sandboxManager = createMockSandboxManager();

    brain.call
      .mockResolvedValueOnce(toolCallResponse('files.read', { path: '/nope' }))
      .mockResolvedValue(stopResponse('recovered'));
    tools.execute.mockRejectedValue(new Error('kaboom: disk on fire'));

    const loop = new AgentLoop(brain, tools, sessions, { maxIterations: 5 }, undefined, undefined, undefined, undefined, sandboxManager);

    const toolResults: Array<{ result: string; success?: boolean }> = [];
    await loop.run('test-session-id', 'read the file', (e) => {
      if (e.type === 'tool-result') toolResults.push({ result: String(e.result), success: e.success });
    });

    // The thrown error surfaced as a failed observation (not swallowed) …
    const failed = toolResults.find((r) => r.success === false);
    expect(failed).toBeDefined();
    expect(failed!.result).toContain('Error executing tool files.read');
    expect(failed!.result).toContain('kaboom: disk on fire');
    // … and the loop went on to a normal completion (brain consulted again).
    expect(brain.call.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('AL1.1(b) — doom-loop negative: changed-args retries never fire', () => {
  it('stays silent across many same-tool DIFFERENT-args calls (beyond both thresholds)', () => {
    const detector = new DoomLoopDetector(null);
    const total = DOOM_LOOP_RO_THRESHOLD + 2; // past even the abort threshold
    for (let turn = 1; turn <= total; turn++) {
      detector.onNewTurn();
      const result = detector.recordCall('files.read', { path: `/part-${turn}.txt` }, turn);
      expect(result.action).toBe('allow');
    }
  });

  it('control: identical args still warn at the threshold (the detector is not dead)', () => {
    const detector = new DoomLoopDetector(null);
    let lastAction = 'allow';
    for (let turn = 1; turn <= DOOM_LOOP_THRESHOLD; turn++) {
      detector.onNewTurn();
      lastAction = detector.recordCall('files.read', { path: '/same.txt' }, turn).action;
    }
    expect(lastAction).toBe('warn');
  });
});

describe('AL1.1(d) — max-iterations halt is typed and reportable', () => {
  it('halts with PipelineError(pipeline_max_iterations) whose message names the limit', async () => {
    const brain = createMockBrain();
    const tools = createMockToolRegistry();
    const sessions = createMockSessionManager();
    const sandboxManager = createMockSandboxManager();

    brain.call.mockResolvedValue(toolCallResponse('system.loop'));
    tools.execute.mockResolvedValue({ success: true, output: 'looped' });

    const loop = new AgentLoop(brain, tools, sessions, { maxIterations: 3 }, undefined, undefined, undefined, undefined, sandboxManager);

    let thrown: unknown;
    // Pin the legacy throw contract: SUDO_MAX_ITER_FALLBACK=0 disables the
    // graceful fallback reply (default-on; covered by max-iter-fallback.test.ts).
    process.env['SUDO_MAX_ITER_FALLBACK'] = '0';
    try {
      await loop.run('test-session-id', 'loop forever');
    } catch (err) {
      thrown = err;
    } finally {
      delete process.env['SUDO_MAX_ITER_FALLBACK'];
    }
    expect(thrown).toBeInstanceOf(PipelineError);
    const pe = thrown as PipelineError;
    expect(pe.code).toBe('pipeline_max_iterations');
    // Reportable: the message must be self-explanatory to a channel/user.
    expect(pe.message.toLowerCase()).toContain('iteration');
  });
});
