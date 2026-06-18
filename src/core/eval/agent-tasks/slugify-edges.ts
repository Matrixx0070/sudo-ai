/**
 * @file slugify-edges.ts
 * @description Agent implements `slugify(s)` from scratch satisfying 12 edge-case
 * assertions: lowercase, whitespace → dash, punctuation removed, collapsed
 * duplicate dashes, trimmed leading/trailing dashes, empty input → empty string,
 * unicode-letter preservation (\\w), digit preservation.
 *
 * Exercises: comprehensive spec-following. Each assertion is a separate edge
 * case an agent might miss; ALL must pass for score=1. This is harder than
 * `implement-from-spec` (fibonacci) because the rules interact (e.g. you
 * collapse duplicate dashes only AFTER substituting whitespace/punctuation).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentBenchTask } from '../agent-bench-types.js';
import { verifyWorkspaceExec } from '../verifiers/workspace-exec-verifier.js';

const EMPTY_SLUG_PY = `# slug.py — implement slugify(s) here. See test_slug.py for the full spec.
`;

const HELD_OUT_TESTS = `# test_slug.py — 12 edge-case assertions. ALL must pass.
# DO NOT modify this file. Only edit slug.py.
import pytest
from slug import slugify


def test_basic_lowercase():
    assert slugify("Hello World") == "hello-world"


def test_already_clean():
    assert slugify("simple") == "simple"


def test_empty_string_returns_empty():
    assert slugify("") == ""


def test_whitespace_only_returns_empty():
    assert slugify("   ") == ""


def test_leading_trailing_whitespace_trimmed():
    assert slugify("  hello  ") == "hello"


def test_punctuation_removed():
    assert slugify("Hello, World!") == "hello-world"


def test_multiple_spaces_collapse_to_single_dash():
    assert slugify("hello   world") == "hello-world"


def test_underscores_become_dashes_or_kept_consistently():
    # Either "hello-world" or "hello_world" or any single consistent treatment.
    # We accept anything that does not produce a dash-underscore mix and matches
    # one of the two reasonable forms.
    out = slugify("hello_world")
    assert out in ("hello-world", "hello_world"), f"unexpected: {out!r}"


def test_digits_preserved():
    assert slugify("Top 10 Tips") == "top-10-tips"


def test_repeated_punctuation_no_double_dashes():
    assert slugify("hello!!!world") == "hello-world"


def test_leading_punctuation_trimmed():
    assert slugify("---hello---") == "hello"


def test_unicode_letters_preserved_or_removed_consistently():
    # Accept either preserving unicode (café -> café) OR stripping it (café -> caf).
    # Reject crashes and reject leaving raw whitespace/punct.
    out = slugify("Café Latté")
    assert "-" in out or out == "" or " " not in out, f"unexpected: {out!r}"
    assert out == out.lower()
`;

export const slugifyEdgesTask: AgentBenchTask = {
  id: 'agent-slugify-edges',
  name: 'Implement slugify(s) satisfying 12 interacting edge cases',
  prompt: [
    'You are working in {workspace}. The file {workspace}/slug.py is empty —',
    'implement a `slugify(s: str) -> str` function in it from scratch.',
    '',
    'The held-out test {workspace}/test_slug.py has 12 assertions covering:',
    '  - lowercasing',
    '  - whitespace → dash, multiple whitespace collapses',
    '  - leading / trailing whitespace and dashes trimmed',
    '  - punctuation removed',
    '  - repeated punctuation must not yield consecutive dashes',
    '  - digits preserved',
    '  - underscores may be kept OR converted to dashes (consistent)',
    '  - empty / whitespace-only input → empty string',
    '  - unicode letters may be preserved OR stripped (consistent; no raw whitespace)',
    '',
    'Do NOT modify the test file. Read it before implementing — it spells out the spec.',
    '',
    'Verifier: `pytest test_slug.py`, exit code 0. ALL 12 tests must pass.',
  ].join('\n'),
  timeoutMs: 240_000,
  maxIterations: 50,

  async setupWorkspace(workspaceDir: string): Promise<void> {
    await fs.writeFile(path.join(workspaceDir, 'slug.py'), EMPTY_SLUG_PY, 'utf8');
    await fs.writeFile(path.join(workspaceDir, 'test_slug.py'), HELD_OUT_TESTS, 'utf8');
  },

  async verifyWorkspace(workspaceDir: string) {
    return verifyWorkspaceExec(workspaceDir, {
      command: 'python3 -m pytest test_slug.py -q --no-header',
      timeoutMs: 15_000,
    });
  },
};
