/**
 * coder.read-file path guard — regression for the projectRoot depth bug.
 *
 * The guard resolved projectRoot with `../../../../` (up 4 → <root>/src), so it
 * wrongly blocked every in-repo file OUTSIDE src/ (package.json, tests/, docs/) —
 * ~34 real failures surfaced by the trace-failure flywheel. Fixed to `../../../../../`
 * (up 5 → <root>), matching edit-file/write-file. A genuine escape must still be blocked.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import readFileTool from '../../../src/core/tools/builtin/coder/read-file.js';

const tool = (readFileTool as unknown as { default?: typeof readFileTool }).default ?? readFileTool;
const REPO = process.cwd();
function ctx() {
  return { workingDir: REPO, logger: { info() {}, error() {} }, signal: undefined } as never;
}

describe('coder.read-file path guard', () => {
  it('reads an in-repo file OUTSIDE src/ (the bug: package.json was blocked)', async () => {
    const r = await tool.execute({ path: join(REPO, 'package.json') }, ctx());
    expect(r.output).not.toMatch(/Path traversal blocked/);
    expect(r.success).toBe(true);
  });

  it('still BLOCKS a genuine escape outside the project root', async () => {
    const r = await tool.execute({ path: '/etc/passwd' }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/Path traversal blocked/);
  });

  it('still BLOCKS reading a credentials file outside the repo', async () => {
    const r = await tool.execute({ path: '/root/.claude/.credentials.json' }, ctx());
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/Path traversal blocked/);
  });
});
