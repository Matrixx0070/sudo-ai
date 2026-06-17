/**
 * brain-verifier-exec — test-execution verifier unit tests.
 *
 * Mocks runInSandbox so the suite stays portable (no bwrap required in
 * CI) and lets us drive every score path deterministically.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runInSandboxMock } = vi.hoisted(() => ({ runInSandboxMock: vi.fn() }));
vi.mock('../../../src/core/sandbox/sandbox-runner.js', () => ({
  runInSandbox: runInSandboxMock,
}));

// Imports MUST come after vi.mock so the mock is in place at module
// load time.
import { makeExecVerifier, extractCodeFromCandidate } from '../../../src/core/brain/brain-verifier-exec.js';
import type { BrainResponse, BrainRequest } from '../../../src/core/brain/types.js';

function mkResp(content: string): BrainResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0 },
    model: 'ollama/kimi-k2.7-code:cloud',
    finishReason: 'stop',
  };
}

const REQ: BrainRequest = { messages: [{ role: 'user', content: 'demo' }] };

beforeEach(() => {
  runInSandboxMock.mockReset();
});

describe('extractCodeFromCandidate', () => {
  it('returns the body of the first fenced block when present', () => {
    const src = 'Here you go:\n```ts\nconst x = 1;\n```\nThat works.';
    expect(extractCodeFromCandidate(src)).toBe('const x = 1;');
  });

  it('handles bare ``` fences with no language tag', () => {
    expect(extractCodeFromCandidate('```\nplain code\n```')).toBe('plain code');
  });

  it('falls back to raw content when there is no fence', () => {
    expect(extractCodeFromCandidate('  function f(){}  ')).toBe('function f(){}');
  });

  it('returns empty string for empty / whitespace-only content', () => {
    expect(extractCodeFromCandidate('')).toBe('');
    expect(extractCodeFromCandidate('   \n  ')).toBe('');
  });
});

describe('makeExecVerifier', () => {
  it('throws when testCommand is missing', () => {
    expect(() => makeExecVerifier({ testCommand: '' })).toThrow(/testCommand is required/);
    expect(() => makeExecVerifier({ testCommand: '   ' })).toThrow(/testCommand is required/);
  });

  it('scores 1.0 when the test command exits 0', async () => {
    runInSandboxMock.mockResolvedValueOnce({ stdout: 'OK\n', stderr: '', exitCode: 0 });
    const verify = makeExecVerifier({ testCommand: 'node --test test.mjs' });

    const verdict = await verify(mkResp('```js\nexport const x = 1\n```'), REQ);

    expect(verdict.score).toBe(1.0);
    expect(verdict.reason).toBeUndefined();
    expect(runInSandboxMock).toHaveBeenCalledTimes(1);
    expect(runInSandboxMock.mock.calls[0]?.[0].command).toBe('node --test test.mjs');
  });

  it('scores 0.0 with a Reflexion reason when the test command fails', async () => {
    runInSandboxMock.mockResolvedValueOnce({
      stdout: '',
      stderr: 'AssertionError: expected 4 got 5\n  at test.mjs:7',
      exitCode: 1,
    });
    const verify = makeExecVerifier({ testCommand: 'node --test test.mjs' });

    const verdict = await verify(mkResp('export const f = () => 5'), REQ);

    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toContain('test command exited 1');
    expect(verdict.reason).toContain('AssertionError: expected 4 got 5');
  });

  it('truncates verbose output tails with an ellipsis', async () => {
    const huge = 'x'.repeat(5000);
    runInSandboxMock.mockResolvedValueOnce({ stdout: '', stderr: huge, exitCode: 2 });
    const verify = makeExecVerifier({ testCommand: 'cmd' });

    const verdict = await verify(mkResp('code'), REQ);

    expect(verdict.reason).toMatch(/^test command exited 2: …/);
    // tail cap = 600, plus prefix/ellipsis — well under 1000
    expect(verdict.reason!.length).toBeLessThan(1000);
  });

  it('scores 0.0 when no code can be extracted', async () => {
    const verify = makeExecVerifier({ testCommand: 'cmd' });
    const verdict = await verify(mkResp(''), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toMatch(/no code extracted/);
    expect(runInSandboxMock).not.toHaveBeenCalled();
  });

  it('falls back to stdout when stderr is empty', async () => {
    runInSandboxMock.mockResolvedValueOnce({
      stdout: 'expected: 42\nactual:   41',
      stderr: '',
      exitCode: 1,
    });
    const verify = makeExecVerifier({ testCommand: 'cmd' });
    const verdict = await verify(mkResp('code'), REQ);
    expect(verdict.reason).toContain('expected: 42');
  });

  it('writes the testFiles into the workspace before running', async () => {
    runInSandboxMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const verify = makeExecVerifier({
      testCommand: 'node --test test.mjs',
      candidateFile: 'solution.mjs',
      testFiles: {
        'test.mjs': 'import { strictEqual } from "node:assert";\nstrictEqual(1, 1);',
      },
    });

    const verdict = await verify(mkResp('export const x = 1'), REQ);
    expect(verdict.score).toBe(1.0);

    // Verify the sandbox was handed a workspaceDir — exact path is tmpdir-relative
    const call = runInSandboxMock.mock.calls[0]?.[0];
    expect(call.workspaceDir).toMatch(/sudo-brain-verify-/);
  });

  it('surfaces sandbox throws as a verifier failure with reason', async () => {
    runInSandboxMock.mockRejectedValueOnce(new Error('bwrap missing'));
    const verify = makeExecVerifier({ testCommand: 'cmd' });
    const verdict = await verify(mkResp('code'), REQ);
    expect(verdict.score).toBe(0.0);
    expect(verdict.reason).toContain('verifier exec error');
    expect(verdict.reason).toContain('bwrap missing');
  });

  it('merges caller policy onto the default (network gate preserved unless overridden)', async () => {
    runInSandboxMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const verify = makeExecVerifier({
      testCommand: 'cmd',
      policy: { cpuSeconds: 90 }, // override only cpu, keep network: 'none'
    });

    await verify(mkResp('code'), REQ);

    const call = runInSandboxMock.mock.calls[0]?.[0];
    expect(call.policy.cpuSeconds).toBe(90);
    expect(call.policy.network).toBe('none');
    expect(call.policy.enabled).toBe(true);
  });

  it('honours opts.timeoutMs', async () => {
    runInSandboxMock.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const verify = makeExecVerifier({ testCommand: 'cmd', timeoutMs: 5000 });

    await verify(mkResp('code'), REQ);

    const call = runInSandboxMock.mock.calls[0]?.[0];
    expect(call.timeoutMs).toBe(5000);
  });

  it('isolates workspaces between candidates (different tmpdirs)', async () => {
    runInSandboxMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const verify = makeExecVerifier({ testCommand: 'cmd' });

    await verify(mkResp('code A'), REQ);
    await verify(mkResp('code B'), REQ);

    const dirA = runInSandboxMock.mock.calls[0]?.[0].workspaceDir;
    const dirB = runInSandboxMock.mock.calls[1]?.[0].workspaceDir;
    expect(dirA).not.toBe(dirB);
  });
});
