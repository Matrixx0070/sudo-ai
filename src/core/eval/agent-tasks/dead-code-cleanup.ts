/**
 * @file dead-code-cleanup.ts
 * @description Agent must DELETE unused files from a workspace. 5 source
 * files; 2 are unreferenced and one of them even has an import error that
 * would prevent the test suite from collecting. Agent must:
 *   1. Read each file + identify which ones are referenced by app.py
 *   2. Delete the 2 unreferenced files
 *   3. Leave the rest intact
 *
 * Held-out test asserts BOTH `os.path.exists(...) == False` for the unused
 * files AND that app.py's functionality still works. The presence of
 * unused1.py with a broken import also means pytest collection will fail
 * if it isn't removed — which doubles as an implicit signal to the agent
 * that "running pytest now" reveals the cleanup is needed.
 *
 * Exercises: file deletion (rm tool), understanding what's safe to remove.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentBenchTask } from '../agent-bench-types.js';
import { verifyWorkspaceExec } from '../verifiers/workspace-exec-verifier.js';

const APP_PY = `# app.py — entry point. Uses calc.py.
from calc import add, multiply


def compute(x, y):
    return add(x, multiply(x, y))
`;

const CALC_PY = `# calc.py — USED by app.py. KEEP.
def add(a, b):
    return a + b


def multiply(a, b):
    return a * b
`;

const UNUSED1_PY = `# unused1.py — NOT referenced anywhere. DELETE.
# (Also has a broken import that would break pytest collection.)
from does_not_exist_module import nope  # noqa
`;

const UNUSED2_PY = `# unused2.py — NOT referenced anywhere. DELETE.
def old_helper():
    return 'this function is not called from anywhere'
`;

const HELD_OUT_TESTS = `# test_cleanup.py — held-out tests the agent must satisfy.
# DO NOT modify this file.
import os

# The two unused files must be removed.
def test_unused1_is_deleted():
    assert not os.path.exists('unused1.py'), "unused1.py should be deleted (unreferenced + broken import)"


def test_unused2_is_deleted():
    assert not os.path.exists('unused2.py'), "unused2.py should be deleted (unreferenced)"


# The kept files must continue to work.
def test_app_still_works():
    from app import compute
    assert compute(3, 4) == 15  # 3 + (3*4)
    assert compute(0, 5) == 0
    assert compute(2, 2) == 6
`;

export const deadCodeCleanupTask: AgentBenchTask = {
  id: 'agent-dead-code-cleanup',
  name: 'Identify and delete 2 unreferenced files from a 5-file project',
  prompt: [
    'You are working in {workspace}. The directory contains:',
    '  - app.py        (entry point)',
    '  - calc.py       (helpers)',
    '  - unused1.py    (?)',
    '  - unused2.py    (?)',
    '  - test_cleanup.py  (held-out tests — do NOT modify)',
    '',
    'TASK:',
    '  1. Identify which files are NOT referenced from app.py (directly or transitively).',
    '  2. DELETE the unreferenced files using the appropriate tool.',
    '  3. Do NOT delete app.py, calc.py, or test_cleanup.py.',
    '',
    'The held-out test verifies:',
    "  - `os.path.exists('unused1.py')` is False",
    "  - `os.path.exists('unused2.py')` is False",
    "  - `app.compute(...)` still works correctly",
    '',
    'Hint: one of the unused files has a broken import — running pytest before',
    'cleanup will fail at collection time. That is expected; clean up first.',
    '',
    'Verifier: `pytest test_cleanup.py`, exit code 0.',
  ].join('\n'),
  timeoutMs: 180_000,
  maxIterations: 40,

  async setupWorkspace(workspaceDir: string): Promise<void> {
    await fs.writeFile(path.join(workspaceDir, 'app.py'), APP_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'calc.py'), CALC_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'unused1.py'), UNUSED1_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'unused2.py'), UNUSED2_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'test_cleanup.py'), HELD_OUT_TESTS, 'utf8');
  },

  async verifyWorkspace(workspaceDir: string) {
    return verifyWorkspaceExec(workspaceDir, {
      command: 'python3 -m pytest test_cleanup.py -q --no-header',
      timeoutMs: 15_000,
    });
  },
};
