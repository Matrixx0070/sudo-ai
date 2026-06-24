/**
 * @file self-verify.test.ts
 * @description Tests for SelfVerify — mocked to avoid actual git/test execution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SelfVerify } from '../../src/core/agent/self-verify.js';

// Mock child_process to avoid actual command execution
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
}));

describe('SelfVerify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass when files were modified and goal addressed', async () => {
    const brain = {
      call: vi.fn().mockResolvedValue({
        content: '{"aligned": true, "reasoning": "Changes directly address the goal"}',
      }),
    };
    const verifier = new SelfVerify(brain);
    const result = await verifier.verify(
      'Fix the login bug',
      ['src/auth/login.ts'],
      process.cwd(),
    );
    expect(result.verdict).toBeDefined();
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('should have a failed check when filesChanged is empty but a real diff exists', async () => {
    // Force a non-empty diff probe so the whole-verifier abstain path
    // (filesChanged=[] + empty diff) does not fire. Then Check 1 ("Files
    // were modified to address the goal") must still fail because the
    // caller reported no files changed despite the working tree showing one.
    const { execSync } = await import('node:child_process');
    (execSync as unknown as { mockReturnValueOnce: (v: string) => void }).mockReturnValueOnce(
      ' src/x.ts | 5 +++--',
    );
    const brain = {
      call: vi.fn().mockResolvedValue({
        content: '{"aligned": false, "reasoning": "No changes made"}',
      }),
    };
    const verifier = new SelfVerify(brain);
    const result = await verifier.verify(
      'Fix the login bug',
      [],
      process.cwd(),
    );
    expect(result.checks.some(c => !c.passed)).toBe(true);
  });

  it('should work without brain (fallback mode)', async () => {
    const verifier = new SelfVerify(null);
    const result = await verifier.verify(
      'Add a feature',
      ['src/feature.ts'],
      process.cwd(),
    );
    expect(result.verdict).toBeDefined();
    expect(result.summary).toBeTruthy();
  });

  it('should handle brain call failure gracefully', async () => {
    const brain = {
      call: vi.fn().mockRejectedValue(new Error('API error')),
    };
    const verifier = new SelfVerify(brain);
    const result = await verifier.verify(
      'Fix a bug',
      ['src/fix.ts'],
      process.cwd(),
    );
    expect(result.verdict).toBeDefined();
  });

  it('should build a human-readable summary', async () => {
    const verifier = new SelfVerify(null);
    const result = await verifier.verify(
      'Fix the login bug',
      ['src/auth.ts'],
      process.cwd(),
    );
    expect(result.summary).toContain('Self-Verify');
    const hasVerdict = result.summary.includes('PASS') || result.summary.includes('FAIL') || result.summary.includes('PARTIAL');
    expect(hasVerdict).toBe(true);
  });

  it('should detect incomplete verification with brain returning not aligned', async () => {
    const brain = {
      call: vi.fn().mockResolvedValue({
        content: '{"aligned": false, "reasoning": "Changes do not address the goal"}',
      }),
    };
    const verifier = new SelfVerify(brain);
    const result = await verifier.verify(
      'Fix the security vulnerability',
      ['src/feature.ts'],
      process.cwd(),
    );
    expect(result.checks.some(c => !c.passed)).toBe(true);
  });

  it('should produce a confidence score', async () => {
    const verifier = new SelfVerify(null);
    const result = await verifier.verify(
      'Test task',
      ['src/main.ts'],
      process.cwd(),
    );
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('should skip the goal-alignment LLM call when there is no change history', async () => {
    const brain = {
      call: vi.fn().mockResolvedValue({ content: '{"aligned": true}' }),
    };
    const verifier = new SelfVerify(brain);
    // Force a non-empty diff so we exercise the goal-alignment-skip path
    // rather than the whole-verifier-abstain path added below.
    const { execSync } = await import('node:child_process');
    (execSync as unknown as { mockReturnValueOnce: (v: string) => void }).mockReturnValueOnce(
      ' src/x.ts | 1 +',
    );
    const result = await verifier.verify(
      'What is 7 times 8?',
      [], // pure Q&A: no files changed
      process.cwd(),
    );
    // Brain must not be queried — there is nothing to align against.
    expect(brain.call).not.toHaveBeenCalled();
    const alignmentCheck = result.checks.find(c => c.description.startsWith('Goal alignment'));
    expect(alignmentCheck).toBeDefined();
    expect(alignmentCheck?.passed).toBe(true);
    expect(alignmentCheck?.evidence).toMatch(/no.*changes|nothing to verify/i);
  });

  it('should abstain (verdict=pass, confidence=1) when filesChanged=[] AND diff is empty', async () => {
    const brain = {
      call: vi.fn().mockResolvedValue({ content: '{"aligned": true}' }),
    };
    const verifier = new SelfVerify(brain);
    // child_process.execSync is mocked to return '' globally — diff probe will be empty.
    const result = await verifier.verify(
      'What is 9 times 6?',
      [],
      process.cwd(),
    );
    expect(result.verdict).toBe('pass');
    expect(result.confidence).toBe(1);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[0].description).toMatch(/skipped|no change history/i);
    expect(brain.call).not.toHaveBeenCalled();
  });

  it('calls the brain with a BrainRequest object (not a bare array) so alignment actually runs', async () => {
    // Mirror the REAL Brain contract: call(request) reads request.messages and
    // throws "BrainRequest.messages must be non-empty" if it isn't a non-empty
    // array. The pre-fix code passed a bare ARRAY, so request.messages was
    // undefined → every goal-alignment call threw and silently fell through to
    // "assuming aligned" (logged 62-172×/day). The prior mocks accepted any
    // args, so they never caught it — this one enforces the contract.
    const received: unknown[] = [];
    const brain = {
      call: vi.fn(async (request: { messages?: Array<{ role: string; content: string }> }) => {
        received.push(request);
        if (!request || Array.isArray(request) || !Array.isArray(request.messages) || request.messages.length === 0) {
          throw new Error('BrainRequest.messages must be non-empty');
        }
        return { content: '{"aligned": true, "reasoning": "changes accomplish the goal"}' };
      }),
    };
    const verifier = new SelfVerify(brain);
    const result = await verifier.verify('add feature X', ['src/foo.ts'], process.cwd());

    // Called once, with a request OBJECT carrying a non-empty messages array.
    expect(brain.call).toHaveBeenCalledTimes(1);
    expect(Array.isArray(received[0])).toBe(false);
    expect(Array.isArray((received[0] as { messages?: unknown }).messages)).toBe(true);

    // Goal alignment reflects the REAL semantic result, not the pre-fix
    // "Semantic verification unavailable — assuming aligned" fallthrough.
    const alignment = result.checks.find(c => /alignment/i.test(c.description));
    expect(alignment?.evidence).toContain('changes accomplish the goal');
  });
});