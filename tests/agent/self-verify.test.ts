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

  it('should have a failed check when no files were modified', async () => {
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
});