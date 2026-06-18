/**
 * @file divide-bug.ts
 * @description One real agentic benchmark task: agent must fix a broken Python
 * `divide(a, b)` function so a held-out pytest suite passes. Two failing tests:
 *   1. divide(10, 2) must return 5  (sanity, should already pass)
 *   2. divide(1, 0) must NOT raise ZeroDivisionError (the bug)
 *
 * Agent receives the workspace path in its prompt and uses its read/write/exec
 * tools to edit divide.py. The verifier runs `pytest test_divide.py` in the
 * project sandbox and scores by exit code.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentBenchTask } from '../agent-bench-types.js';
import { verifyWorkspaceExec } from '../verifiers/workspace-exec-verifier.js';

const INITIAL_DIVIDE_PY = `# divide.py — currently broken
def divide(a, b):
    return a / b
`;

const HELD_OUT_TESTS = `# test_divide.py — held-out tests the agent must satisfy.
# DO NOT modify this file. Only edit divide.py.
import pytest
from divide import divide


def test_simple_division():
    assert divide(10, 2) == 5
    assert divide(-6, 3) == -2


def test_zero_divisor_does_not_raise_bare_zerodivisionerror():
    """The fix must NOT propagate a bare ZeroDivisionError.
    Accepted: returns None, raises ValueError, returns a sentinel, etc.
    """
    try:
        divide(1, 0)
    except ZeroDivisionError as e:
        pytest.fail(f"bare ZeroDivisionError still raised: {e}")
    except Exception:
        pass  # any other handling is accepted
`;

export const divideBugTask: AgentBenchTask = {
  id: 'agent-divide-bug',
  name: 'Fix divide() to not propagate ZeroDivisionError',
  prompt: [
    'You are working in {workspace}. The file {workspace}/divide.py contains a broken Python function:',
    '',
    '```python',
    'def divide(a, b):',
    '    return a / b',
    '```',
    '',
    'The held-out test file {workspace}/test_divide.py asserts:',
    '  1. divide(10, 2) == 5  (already passes)',
    '  2. divide(1, 0) must NOT propagate a bare ZeroDivisionError',
    '',
    'TASK: Edit {workspace}/divide.py so both tests pass. You may return None, raise',
    'ValueError, or return any sentinel — anything except letting ZeroDivisionError',
    'propagate. Do NOT modify test_divide.py.',
    '',
    'When done, the held-out verifier will run `pytest test_divide.py` and accept exit code 0.',
  ].join('\n'),
  timeoutMs: 120_000,
  maxIterations: 30,

  async setupWorkspace(workspaceDir: string): Promise<void> {
    await fs.writeFile(path.join(workspaceDir, 'divide.py'), INITIAL_DIVIDE_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'test_divide.py'), HELD_OUT_TESTS, 'utf8');
  },

  async verifyWorkspace(workspaceDir: string) {
    return verifyWorkspaceExec(workspaceDir, {
      command: 'python3 -m pytest test_divide.py -q --no-header',
      timeoutMs: 15_000,
    });
  },
};
