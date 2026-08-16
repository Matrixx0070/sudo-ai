import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards a packaging landmine: `.gitignore` used to carry a blanket `*.py`
 * whose correctness depended on one `!` negation per vendored Python tree.
 * Any new tree without a negation was silently dropped from the shipped
 * package (this happened once, to the textproc fallbacks).
 *
 * These tests fail if the blanket rule comes back, or if a vendored Python
 * tree stops being tracked by git.
 *
 * They deliberately assert only over git's *index* and over `check-ignore`
 * probes on hypothetical paths — never over "everything on disk". Walking the
 * disk made the suite fail on any developer machine that happened to hold an
 * untracked scratch script, a local `venv/`, or a `__pycache__` under one of
 * these directories; none of that is a packaging regression, and none of it
 * can exist in CI (which only ever checks out tracked files).
 */

const REPO = path.resolve(__dirname, '../..');

/** Vendored Python trees that ship as product code. */
const SHIPPED_TREES = [
  'src/core/tools/builtin/textproc/fallbacks',
  'src/core/tools/builtin/docx/scripts',
  'src/core/tools/builtin/pptx/scripts',
  'src/core/tools/builtin/spreadsheet/scripts',
  'src/core/tools/builtin/document/scripts',
  'src/core/tools/builtin/media/scripts',
  'src/core/tools/builtin/code',
  'scripts/grok-web',
  'scripts/gemini-web',
];

/**
 * Floor, not an exact count: new vendored scripts land regularly, but a drop
 * of this magnitude means a tree went missing.
 */
const MIN_TRACKED_PY = 60;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });
}

/** Tracked `.py` paths under `dir` (index only — dirty worktrees don't matter). */
function trackedPy(dir: string): string[] {
  return git(['ls-files', '-z', '--', `${dir}/*.py`]).split('\0').filter(Boolean);
}

/** true when git would ignore `rel` (the path need not exist). */
function isIgnored(rel: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: REPO });
    return true;
  } catch {
    return false;
  }
}

describe('vendored python stays packaged', () => {
  it('has no blanket *.py ignore rule', () => {
    const rules = readFileSync(path.join(REPO, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(rules).not.toContain('*.py');
    expect(rules).not.toContain('**/*.py');
  });

  it('does not ignore Python under a hypothetical NEW vendored tree', () => {
    // The exact failure mode: a tree nobody remembered to add a negation for.
    expect(isIgnored('src/core/tools/builtin/brand-new-tool/scripts/tool.py')).toBe(false);
    expect(isIgnored('scripts/brand-new-lane/bridge.py')).toBe(false);
  });

  it('keeps every shipped vendored tree tracked, and accepting new files', () => {
    const empty: string[] = [];
    const ignoredTrees: string[] = [];
    let total = 0;

    for (const tree of SHIPPED_TREES) {
      const files = trackedPy(tree);
      total += files.length;
      if (files.length === 0) empty.push(tree);
      // A tree can also die by having *future* files silently swallowed while
      // the already-committed ones stay tracked.
      if (isIgnored(`${tree}/__probe_new_script__.py`)) ignoredTrees.push(tree);
    }

    expect(empty, 'vendored Python trees with no tracked .py — moved, deleted, or ignored').toEqual(
      [],
    );
    expect(ignoredTrees, 'vendored Python trees where a NEW .py would be ignored').toEqual([]);
    expect(total).toBeGreaterThanOrEqual(MIN_TRACKED_PY);
  });

  it('has no tracked .py that the ignore rules would swallow', () => {
    // `ls-files -c -i` lists tracked files matching an ignore rule: exactly the
    // fingerprint a re-added blanket `*.py` leaves behind. Index-only, so an
    // untracked scratch file or a local venv cannot trip it.
    const swallowed = git(['ls-files', '-z', '-c', '-i', '--exclude-standard', '--', '*.py'])
      .split('\0')
      .filter(Boolean);
    expect(swallowed).toEqual([]);
  });

  it('still ignores python build artifacts', () => {
    expect(isIgnored('src/core/tools/builtin/docx/scripts/__pycache__/x.pyc')).toBe(true);
    expect(isIgnored('some/where/module.pyc')).toBe(true);
    expect(isIgnored('.venv/lib/python3/site.py')).toBe(true);
  });
});
