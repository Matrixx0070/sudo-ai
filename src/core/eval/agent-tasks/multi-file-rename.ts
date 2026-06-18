/**
 * @file multi-file-rename.ts
 * @description Agent must rename a function `compute_total` → `calculate_total`
 * across THREE files (one definition, two call sites). The held-out test
 * imports under the NEW name and asserts behavior. Tests pass iff every call
 * site was updated AND the original definition was renamed (not duplicated).
 *
 * Exercises: planning, multiple write tool calls, codebase-wide consistency.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentBenchTask } from '../agent-bench-types.js';
import { verifyWorkspaceExec } from '../verifiers/workspace-exec-verifier.js';

const INITIAL_MATH_PY = `# math_utils.py
def compute_total(items):
    """Sum a list of numbers."""
    total = 0
    for item in items:
        total += item
    return total
`;

const INITIAL_ORDER_PY = `# order.py
from math_utils import compute_total


def order_grand_total(line_items):
    return compute_total(line_items)
`;

const INITIAL_CART_PY = `# cart.py
from math_utils import compute_total


def cart_subtotal(prices):
    return compute_total(prices) * 1.0  # placeholder tax-free
`;

const HELD_OUT_TESTS = `# test_rename.py — held-out tests the agent must satisfy.
# DO NOT modify this file. Only edit math_utils.py, order.py, cart.py.
import pytest

from math_utils import calculate_total  # new name
from order import order_grand_total
from cart import cart_subtotal


def test_calculate_total_exists():
    assert calculate_total([1, 2, 3]) == 6


def test_old_name_is_gone():
    import math_utils
    assert not hasattr(math_utils, 'compute_total'), (
        "compute_total should have been renamed to calculate_total, not duplicated"
    )


def test_call_sites_updated():
    assert order_grand_total([10, 20]) == 30
    assert cart_subtotal([5, 5, 5]) == 15.0
`;

export const multiFileRenameTask: AgentBenchTask = {
  id: 'agent-multi-file-rename',
  name: 'Rename compute_total → calculate_total across 3 files',
  prompt: [
    'You are working in {workspace}. The workspace contains three Python files:',
    '  - math_utils.py  (defines `compute_total(items)`)',
    '  - order.py       (imports + calls compute_total)',
    '  - cart.py        (imports + calls compute_total)',
    '',
    'TASK: Rename the function from `compute_total` to `calculate_total`.',
    'Update the definition in math_utils.py AND every import / call site in',
    'order.py and cart.py. The old name must NOT remain anywhere.',
    '',
    'Do NOT modify {workspace}/test_rename.py.',
    '',
    'The verifier runs `pytest test_rename.py` and accepts exit code 0.',
    'It explicitly checks: calculate_total works, math_utils has NO',
    '`compute_total` attribute, and call sites still return correct values.',
  ].join('\n'),
  timeoutMs: 180_000,
  maxIterations: 50,

  async setupWorkspace(workspaceDir: string): Promise<void> {
    await fs.writeFile(path.join(workspaceDir, 'math_utils.py'), INITIAL_MATH_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'order.py'), INITIAL_ORDER_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'cart.py'), INITIAL_CART_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'test_rename.py'), HELD_OUT_TESTS, 'utf8');
  },

  async verifyWorkspace(workspaceDir: string) {
    return verifyWorkspaceExec(workspaceDir, {
      command: 'python3 -m pytest test_rename.py -q --no-header',
      timeoutMs: 15_000,
    });
  },
};
