/**
 * @file implement-from-spec.ts
 * @description Agent must implement `fibonacci(n)` from scratch — no existing
 * code to reference. Spec is in the prompt + the held-out tests. Measures
 * spec-following accuracy: edge cases for n=0, n=1, and ValueError on n<0.
 *
 * The workspace starts with an empty fib.py (just a placeholder comment) and
 * the test file. Agent must fill in fib.py.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentBenchTask } from '../agent-bench-types.js';
import { verifyWorkspaceExec } from '../verifiers/workspace-exec-verifier.js';

const EMPTY_FIB_PY = `# fib.py — implement fibonacci here. See the test file for the spec.
`;

const HELD_OUT_TESTS = `# test_fib.py — held-out tests the agent must satisfy.
# DO NOT modify this file. Only edit fib.py.
import pytest
from fib import fibonacci


def test_base_cases():
    assert fibonacci(0) == 0
    assert fibonacci(1) == 1


def test_small_values():
    # 0, 1, 1, 2, 3, 5, 8, 13, 21, 34
    assert fibonacci(2) == 1
    assert fibonacci(3) == 2
    assert fibonacci(5) == 5
    assert fibonacci(9) == 34


def test_medium_value():
    assert fibonacci(20) == 6765


def test_negative_raises_value_error():
    with pytest.raises(ValueError):
        fibonacci(-1)
`;

export const implementFromSpecTask: AgentBenchTask = {
  id: 'agent-implement-from-spec',
  name: 'Implement fibonacci(n) from spec, including ValueError on n<0',
  prompt: [
    'You are working in {workspace}. The file {workspace}/fib.py is empty — you',
    'need to implement a `fibonacci(n)` function in it from scratch.',
    '',
    'SPEC (also encoded in the held-out tests in {workspace}/test_fib.py):',
    '  - fibonacci(0) == 0',
    '  - fibonacci(1) == 1',
    '  - fibonacci(n)  for n >= 2 returns the n-th Fibonacci number',
    '    (sequence: 0, 1, 1, 2, 3, 5, 8, 13, 21, 34, ...)',
    '  - fibonacci(n)  for n < 0 must raise ValueError',
    '',
    'Examples: fibonacci(5) == 5; fibonacci(20) == 6765; fibonacci(-1) raises ValueError.',
    '',
    'Do NOT modify the test file. Your implementation may use recursion, iteration,',
    'or memoization — performance is not measured, only correctness.',
    '',
    'The verifier runs `pytest test_fib.py` and accepts exit code 0.',
  ].join('\n'),
  timeoutMs: 120_000,
  maxIterations: 30,

  async setupWorkspace(workspaceDir: string): Promise<void> {
    await fs.writeFile(path.join(workspaceDir, 'fib.py'), EMPTY_FIB_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'test_fib.py'), HELD_OUT_TESTS, 'utf8');
  },

  async verifyWorkspace(workspaceDir: string) {
    return verifyWorkspaceExec(workspaceDir, {
      command: 'python3 -m pytest test_fib.py -q --no-header',
      timeoutMs: 15_000,
    });
  },
};
