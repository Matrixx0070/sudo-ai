/**
 * @file stack-trace-debug.ts
 * @description Agent gets a 3-file Python project that crashes with a stack
 * trace. The trace points into helpers.py — but the bug there is "obvious"
 * (divide-by-len with no empty-check), so the FIX is in helpers.py while the
 * test entry is in main.py. Agent must read across files to understand the
 * call chain before fixing.
 *
 * Held-out test calls `main.run([])` (empty list). The default code crashes
 * with `ZeroDivisionError`. Fix = guard `helpers.average(arr)` for empty input.
 *
 * Exercises: runtime debugging, cross-file reading, choosing where to fix.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentBenchTask } from '../agent-bench-types.js';
import { verifyWorkspaceExec } from '../verifiers/workspace-exec-verifier.js';

const MAIN_PY = `# main.py — entry point
from utils import process_data


def run(items):
    """Returns a summary dict for the given items."""
    return process_data(items)
`;

const UTILS_PY = `# utils.py — orchestration
from helpers import average


def process_data(items):
    """Compute the average of the items."""
    return {"count": len(items), "avg": average(items)}
`;

const HELPERS_PY = `# helpers.py — math helpers (BUGGY)
def average(arr):
    return sum(arr) / len(arr)
`;

const HELD_OUT_TESTS = `# test_run.py — held-out tests the agent must satisfy.
# DO NOT modify this file. Edit any of main.py, utils.py, helpers.py.
import pytest
from main import run


def test_non_empty_list():
    result = run([10, 20, 30])
    assert result["count"] == 3
    assert result["avg"] == 20


def test_empty_list_does_not_crash():
    """Default code raises ZeroDivisionError. Fix: handle empty input.
    Accepted: avg = 0, None, or any sentinel. The point is no crash.
    """
    try:
        result = run([])
    except ZeroDivisionError as e:
        pytest.fail(f"run([]) propagated ZeroDivisionError: {e}")
    except Exception as e:
        pytest.fail(f"run([]) raised unexpected {type(e).__name__}: {e}")
    assert result["count"] == 0


def test_single_item():
    result = run([42])
    assert result["count"] == 1
    assert result["avg"] == 42
`;

export const stackTraceDebugTask: AgentBenchTask = {
  id: 'agent-stack-trace-debug',
  name: 'Debug from stack trace: cross-file ZeroDivisionError on empty input',
  prompt: [
    'You are working in {workspace}. The project has 3 source files:',
    '  - main.py     (defines `run(items)`)',
    '  - utils.py    (defines `process_data`)',
    '  - helpers.py  (defines `average`)',
    '',
    'The held-out test {workspace}/test_run.py calls `run(items)` with several inputs',
    'including an empty list `[]`. The current code crashes with `ZeroDivisionError`',
    'somewhere in this call chain. Find the bug and fix it.',
    '',
    'TASK: Make all tests pass. You may edit ANY of main.py, utils.py, or helpers.py,',
    'but pick the file where the fix actually belongs. Do NOT modify test_run.py.',
    '',
    'Acceptance: the empty-list case must NOT raise (return 0 / None / sentinel — any',
    'handling), and the non-empty cases must still return correct averages.',
    '',
    'Verifier: `pytest test_run.py`, exit code 0.',
  ].join('\n'),
  timeoutMs: 180_000,
  maxIterations: 40,

  async setupWorkspace(workspaceDir: string): Promise<void> {
    await fs.writeFile(path.join(workspaceDir, 'main.py'), MAIN_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'utils.py'), UTILS_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'helpers.py'), HELPERS_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'test_run.py'), HELD_OUT_TESTS, 'utf8');
  },

  async verifyWorkspace(workspaceDir: string) {
    return verifyWorkspaceExec(workspaceDir, {
      command: 'python3 -m pytest test_run.py -q --no-header',
      timeoutMs: 15_000,
    });
  },
};
