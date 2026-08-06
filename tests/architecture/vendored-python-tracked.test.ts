import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards a packaging landmine: `.gitignore` used to carry a blanket `*.py`
 * whose correctness depended on one `!` negation per vendored Python tree.
 * Any new tree without a negation was silently dropped from the shipped
 * package (this happened once, to the textproc fallbacks).
 *
 * These tests fail if the blanket rule comes back, or if a shipped Python
 * file stops being tracked by git.
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

function pyFilesOnDisk(dir: string): string[] {
  const abs = path.join(REPO, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const rel = `${dir}/${entry}`;
    if (statSync(path.join(REPO, rel)).isDirectory()) out.push(...pyFilesOnDisk(rel));
    else if (entry.endsWith('.py')) out.push(rel);
  }
  return out;
}

function trackedPyFiles(): Set<string> {
  const out = execFileSync('git', ['ls-files', '*.py'], { cwd: REPO, encoding: 'utf8' });
  return new Set(out.split('\n').filter(Boolean));
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

  it('tracks every Python file in every shipped vendored tree', () => {
    const tracked = trackedPyFiles();
    const missing: string[] = [];
    let seen = 0;
    for (const tree of SHIPPED_TREES) {
      const files = pyFilesOnDisk(tree);
      expect(files.length, `${tree} has no .py files — tree moved or deleted?`).toBeGreaterThan(0);
      seen += files.length;
      for (const f of files) if (!tracked.has(f)) missing.push(f);
    }
    expect(missing).toEqual([]);
    expect(seen).toBeGreaterThanOrEqual(65);
  });

  it('still ignores python build artifacts', () => {
    expect(isIgnored('src/core/tools/builtin/docx/scripts/__pycache__/x.pyc')).toBe(true);
    expect(isIgnored('some/where/module.pyc')).toBe(true);
    expect(isIgnored('.venv/lib/python3/site.py')).toBe(true);
  });
});
