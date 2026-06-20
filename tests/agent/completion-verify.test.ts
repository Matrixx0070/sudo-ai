/**
 * @file tests/agent/completion-verify.test.ts
 * @description Orphan wiring — CompletionVerifier: a cheap, no-LLM heuristic
 * phantom-completion check of the final response, attached to AgentRunResult as
 * `completionVerification` when SUDO_COMPLETION_VERIFY=1. Additive, opt-in,
 * fail-open, observable-only (never alters the response).
 *
 *   CV-1  flag on + a phantom final response → completionVerification.passed === false
 *   CV-2  flag off → completionVerification undefined (no behavior change)
 *   CV-3  flag on + a genuine final response → completionVerification.passed === true
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
function makeLoop(brain: ReturnType<typeof createMockBrain>, registry = createMockToolRegistry()) {
  return new AgentLoop(brain, registry, createMockSessionManager(), undefined, undefined, undefined, undefined, undefined, createMockSandboxManager());
}
function stop(content = 'done'): BrainResponse {
  return { content, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0 }, model: 'xai/grok-3-fast', finishReason: 'stop' };
}

describe('Orphan wiring: CompletionVerifier loop wiring', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['SUDO_COMPLETION_VERIFY']; delete process.env['SUDO_COMPLETION_VERIFY']; });
  afterEach(() => { if (saved === undefined) delete process.env['SUDO_COMPLETION_VERIFY']; else process.env['SUDO_COMPLETION_VERIFY'] = saved; });

  it('CV-1: flag on + a phantom final response → passed=false with the failing checks named', async () => {
    process.env['SUDO_COMPLETION_VERIFY'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop('TODO')); // placeholder + too short → fails
    const result = await makeLoop(brain).run('test-session-id', 'please complete the task');

    expect(result.completionVerification).toBeDefined();
    expect(result.completionVerification!.passed).toBe(false);
    expect(result.completionVerification!.confidence).toBeLessThan(70);
    expect(result.completionVerification!.failedChecks).toContain('placeholder_detection');
    expect(result.completionVerification!.failedChecks).toContain('output_length');
    expect(result.completionVerification!.failedChecks.length).toBeGreaterThanOrEqual(2);
    // The response itself is untouched (observable-only).
    expect(result.text).toBe('TODO');
  });

  it('CV-2: flag off → no completionVerification (unchanged result)', async () => {
    const brain = createMockBrain();
    brain.call.mockResolvedValue(stop('A complete, adequate answer to the request goes right here.'));
    const result = await makeLoop(brain).run('test-session-id', 'do the thing');
    expect(result.completionVerification).toBeUndefined();
  });

  it('CV-3: flag on + a genuine final response → passed=true', async () => {
    process.env['SUDO_COMPLETION_VERIFY'] = '1';
    const brain = createMockBrain();
    brain.call.mockResolvedValue(
      stop('The quarterly sales report summary: revenue grew twelve percent, costs dropped, and margins improved across all regions this period.'),
    );
    const result = await makeLoop(brain).run('test-session-id', 'summarize the quarterly sales report');

    expect(result.completionVerification).toBeDefined();
    expect(result.completionVerification!.passed).toBe(true);
    expect(result.completionVerification!.failedChecks).toHaveLength(0);
  });
});
