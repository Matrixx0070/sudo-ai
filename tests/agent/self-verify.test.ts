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
});