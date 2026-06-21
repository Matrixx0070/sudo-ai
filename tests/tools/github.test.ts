/**
 * Tests for the github.* connector tools.
 *
 * runCmd (the execFile wrapper) is mocked so no real git/gh runs. Covers:
 *  - env-gated registration (SUDO_GITHUB_TOOLS)
 *  - github.commit (stage+commit, refuse-empty)
 *  - github.merge_pr CI-green gate (failing / pending / no-checks / conflict /
 *    not-open all refuse; green merges)
 *  - github.pr_status summary parsing
 *  - github.open_pr push + number parse
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runCmdMock } = vi.hoisted(() => ({ runCmdMock: vi.fn() }));
vi.mock('../../src/core/tools/builtin/system/exec.js', () => ({ runCmd: runCmdMock }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn(), readFileSync: vi.fn(actual.readFileSync), appendFileSync: vi.fn() };
});

import {
  GITHUB_TOOLS,
  githubCommitTool,
  githubMergePrTool,
  githubPrStatusTool,
  githubOpenPrTool,
  githubReadFileTool,
  githubVerifyTool,
  githubListPrsTool,
  githubPrDiffTool,
  githubPrCommentTool,
  githubUpdateBranchTool,
  githubClosePrTool,
  githubListIssuesTool,
  githubCreateIssueTool,
  githubCommentIssueTool,
  githubCloseIssueTool,
  gitHubToolsEnabled,
} from '../../src/core/tools/builtin/github/github.js';
import { registerGitHubTools } from '../../src/core/tools/builtin/github/index.js';
import type { ToolContext } from '../../src/core/tools/types.js';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

const ctx: ToolContext = { sessionId: 't', workingDir: '/repo', config: {}, logger: {} };
const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const err = (stderr = 'boom', exitCode = 1) => ({ stdout: '', stderr, exitCode });

type Handler = (bin: string, args: string[]) => { stdout: string; stderr: string; exitCode: number } | undefined;
function route(handler: Handler): void {
  runCmdMock.mockImplementation((bin: string, args: string[]) => Promise.resolve(handler(bin, args) ?? ok('')));
}
function prView(over: Record<string, unknown> = {}) {
  return ok(JSON.stringify({
    number: 42, title: 't', state: 'OPEN', mergeable: 'MERGEABLE',
    url: 'https://github.com/o/r/pull/42', statusCheckRollup: [], ...over,
  }));
}
function routePr(view: ReturnType<typeof ok>, merge = ok('')): void {
  route((bin, args) => {
    if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view') return view;
    if (bin === 'gh' && args[0] === 'pr' && args[1] === 'merge') return merge;
    return ok('');
  });
}
const mergeWasCalled = () =>
  runCmdMock.mock.calls.some((c) => c[0] === 'gh' && c[1][0] === 'pr' && c[1][1] === 'merge');

beforeEach(() => {
  runCmdMock.mockReset();
  vi.mocked(writeFileSync).mockClear();
  vi.mocked(mkdirSync).mockClear();
  vi.mocked(readFileSync).mockClear();
  delete process.env['SUDO_GITHUB_TOOLS'];
  delete process.env['SUDO_GITHUB_MERGE_POLL_MS'];
});

describe('github tools — enablement & registration', () => {
  it('gitHubToolsEnabled parses the flag', () => {
    for (const v of ['1', 'true', 'on', 'YES']) { process.env['SUDO_GITHUB_TOOLS'] = v; expect(gitHubToolsEnabled()).toBe(true); }
    for (const v of ['0', 'false', '', 'no']) { process.env['SUDO_GITHUB_TOOLS'] = v; expect(gitHubToolsEnabled()).toBe(false); }
    delete process.env['SUDO_GITHUB_TOOLS']; expect(gitHubToolsEnabled()).toBe(false);
  });

  it('does NOT register tools when disabled (default)', () => {
    const reg = { register: vi.fn() };
    registerGitHubTools(reg as never);
    expect(reg.register).not.toHaveBeenCalled();
  });

  it('registers all 5 tools when enabled', () => {
    process.env['SUDO_GITHUB_TOOLS'] = '1';
    const reg = { register: vi.fn() };
    registerGitHubTools(reg as never);
    expect(reg.register).toHaveBeenCalledTimes(GITHUB_TOOLS.length);
    expect(GITHUB_TOOLS.length).toBe(18);
  });
});

describe('github.commit', () => {
  it('stages, commits, returns sha + branch', async () => {
    route((bin, args) => {
      if (args[0] === 'add') return ok('');
      if (args[0] === 'status') return ok(' M file.ts');
      if (args[0] === 'diff' && args[1] === '--cached') return ok('file.ts');
      if (args[0] === 'commit') return ok('');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('abc1234deadbeef');
      if (args[0] === 'rev-parse') return ok('feature/x'); // --abbrev-ref HEAD (feature branch)
      return ok('');
    });
    const res = await githubCommitTool.execute({ message: 'msg' }, ctx);
    expect(res.success).toBe(true);
    expect((res.data as { sha: string }).sha).toBe('abc1234deadbeef');
    expect((res.data as { branch: string }).branch).toBe('feature/x');
  });

  it('refuses when the tree is clean', async () => {
    route((bin, args) => (args[0] === 'status' ? ok('') : ok('')));
    const res = await githubCommitTool.execute({ message: 'msg' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/nothing to commit/i);
  });

  it('fails when git commit errors', async () => {
    route((bin, args) => {
      if (args[0] === 'status') return ok(' M f');
      if (args[0] === 'diff' && args[1] === '--cached') return ok('f');
      if (args[0] === 'commit') return err('hook rejected');
      return ok('');
    });
    const res = await githubCommitTool.execute({ message: 'm' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/git commit failed/i);
  });
});

describe('github.commit — branch + files', () => {
  it('creates a branch, writes files, stages only those, commits', async () => {
    route((bin, args) => {
      if (args[0] === 'checkout' && args[1] === '-B') return ok('');
      if (args[0] === 'status') return ok(' A docs/x.md');
      if (args[0] === 'diff' && args[1] === '--cached') return ok('docs/x.md');
      if (args[0] === 'commit') return ok('');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('deadbeefcafe');
      if (args[0] === 'rev-parse') return ok('feat/auto');
      return ok('');
    });
    const res = await githubCommitTool.execute(
      { message: 'auto', branch: 'feat/auto', cwd: '/repo', files: [{ path: 'docs/x.md', content: '# hi\n' }] },
      ctx,
    );
    expect(res.success).toBe(true);
    expect((res.data as { branch: string }).branch).toBe('feat/auto');
    // branch switched via checkout -B
    expect(runCmdMock.mock.calls.some((c) => c[0] === 'git' && c[1][0] === 'checkout' && c[1][1] === '-B' && c[1][2] === 'feat/auto')).toBe(true);
    // file written with exact content
    const wrote = vi.mocked(writeFileSync).mock.calls.find((c) => String(c[0]).endsWith('docs/x.md'));
    expect(wrote?.[1]).toBe('# hi\n');
    // staged ONLY the written file, never `add -A`
    expect(runCmdMock.mock.calls.some((c) => c[0] === 'git' && c[1][0] === 'add' && c[1].includes('docs/x.md'))).toBe(true);
    expect(runCmdMock.mock.calls.some((c) => c[0] === 'git' && c[1][0] === 'add' && c[1].includes('-A'))).toBe(false);
  });

  it('rejects a repo-escaping file path (no write, no commit)', async () => {
    route(() => ok(''));
    const res = await githubCommitTool.execute(
      { message: 'm', cwd: '/repo', files: [{ path: '../evil.md', content: 'x' }] },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/escaping|invalid/i);
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(runCmdMock.mock.calls.some((c) => c[1][0] === 'commit')).toBe(false);
  });

  it('refuses to write/commit a protected path (files)', async () => {
    route(() => ok(''));
    const res = await githubCommitTool.execute(
      { message: 'm', cwd: '/repo', branch: 'feat/x', files: [{ path: '.github/workflows/ci.yml', content: 'evil' }] },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/protected path/i);
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(runCmdMock.mock.calls.some((c) => c[1][0] === 'commit')).toBe(false);
  });

  it('refuses to commit directly on the default branch (no branch param)', async () => {
    route((bin, args) => {
      if (args[0] === 'rev-parse') return ok('main');           // current branch = main
      if (args[0] === 'symbolic-ref') return ok('origin/main'); // default branch = main
      return ok('');
    });
    const res = await githubCommitTool.execute({ message: 'm', cwd: '/repo' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/won't commit directly on|protected branch/i);
    expect(runCmdMock.mock.calls.some((c) => c[1][0] === 'commit')).toBe(false);
  });

  it('applies targeted edits (find/replace) to an existing file', async () => {
    vi.mocked(readFileSync).mockReturnValueOnce('export const N = 1;\n');
    route((bin, args) => {
      if (args[0] === 'checkout' && args[1] === '-B') return ok('');
      if (args[0] === 'diff' && args[1] === '--cached') return ok('src/x.ts');
      if (args[0] === 'commit') return ok('');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('abc1234');
      if (args[0] === 'rev-parse') return ok('feat/edit');
      return ok('');
    });
    const res = await githubCommitTool.execute(
      { message: 'm', cwd: '/repo', branch: 'feat/edit', files: [{ path: 'src/x.ts', edits: [{ find: 'N = 1', replace: 'N = 2' }] }] },
      ctx,
    );
    expect(res.success).toBe(true);
    const wrote = vi.mocked(writeFileSync).mock.calls.find((c) => String(c[0]).endsWith('src/x.ts'));
    expect(wrote?.[1]).toBe('export const N = 2;\n');
  });

  it('fails an edit whose find target is missing (no write)', async () => {
    vi.mocked(readFileSync).mockReturnValueOnce('export const N = 1;\n');
    route((bin, args) => (args[0] === 'checkout' && args[1] === '-B' ? ok('') : ok('')));
    const res = await githubCommitTool.execute(
      { message: 'm', cwd: '/repo', branch: 'feat/edit', files: [{ path: 'src/x.ts', edits: [{ find: 'NOT_THERE', replace: 'x' }] }] },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/edit target not found/i);
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });
});

describe('github.read_file', () => {
  it('reads a repo file (read-only)', async () => {
    vi.mocked(readFileSync).mockReturnValueOnce('export const A = 1;\n');
    const res = await githubReadFileTool.execute({ path: 'src/x.ts', cwd: '/repo' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('export const A = 1;');
  });

  it('refuses to read a protected path', async () => {
    const res = await githubReadFileTool.execute({ path: 'config/.env', cwd: '/repo' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/protected path/i);
  });
});

describe('github.verify', () => {
  it('reports lint PASS when tsc exits 0', async () => {
    route((bin) => (bin.endsWith('tsc') ? ok('') : ok('')));
    const res = await githubVerifyTool.execute({ cwd: '/repo' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/lint.*PASS/i);
  });

  it('reports lint FAIL when tsc exits non-zero', async () => {
    route((bin) => (bin.endsWith('tsc') ? err('error TS1234', 2) : ok('')));
    const res = await githubVerifyTool.execute({ cwd: '/repo' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/lint.*FAIL/i);
  });

  it('runs the test suite when tests=true', async () => {
    route(() => ok(''));
    const res = await githubVerifyTool.execute({ cwd: '/repo', tests: true }, ctx);
    expect(res.success).toBe(true);
    expect(runCmdMock.mock.calls.some((c) => String(c[0]).endsWith('vitest'))).toBe(true);
  });
});

describe('github.merge_pr — CI-green gate', () => {
  it('merges when checks are green', async () => {
    routePr(prView({ statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    const res = await githubMergePrTool.execute({}, ctx);
    expect(res.success).toBe(true);
    expect(mergeWasCalled()).toBe(true);
  });

  it('refuses on a failing check (and does not merge)', async () => {
    routePr(prView({ statusCheckRollup: [{ name: 'Build', status: 'COMPLETED', conclusion: 'FAILURE' }] }));
    const res = await githubMergePrTool.execute({}, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/failing/i);
    expect(mergeWasCalled()).toBe(false);
  });

  it('refuses on a pending check (and does not merge)', async () => {
    routePr(prView({ statusCheckRollup: [{ name: 'Test', status: 'IN_PROGRESS', conclusion: null }] }));
    const res = await githubMergePrTool.execute({}, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/pending/i);
    expect(mergeWasCalled()).toBe(false);
  });

  it('refuses zero-checks unless allow_no_checks', async () => {
    routePr(prView({ statusCheckRollup: [] }));
    const r1 = await githubMergePrTool.execute({}, ctx);
    expect(r1.success).toBe(false);
    expect(r1.output).toMatch(/no CI checks/i);
    expect(mergeWasCalled()).toBe(false);

    routePr(prView({ statusCheckRollup: [] }));
    const r2 = await githubMergePrTool.execute({ allow_no_checks: true }, ctx);
    expect(r2.success).toBe(true);
    expect(mergeWasCalled()).toBe(true);
  });

  it('refuses when the PR is not OPEN', async () => {
    routePr(prView({ state: 'MERGED', statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    const res = await githubMergePrTool.execute({}, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/not OPEN/i);
    expect(mergeWasCalled()).toBe(false);
  });

  it('refuses on merge conflicts', async () => {
    routePr(prView({ mergeable: 'CONFLICTING', statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    const res = await githubMergePrTool.execute({}, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/conflict/i);
    expect(mergeWasCalled()).toBe(false);
  });

  it('refuses to merge a PR that touches protected paths (even when CI is green)', async () => {
    routePr(prView({
      files: [{ path: '.github/workflows/ci.yml' }],
      statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    }));
    const res = await githubMergePrTool.execute({}, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/protected path/i);
    expect(mergeWasCalled()).toBe(false);
  });

  it('polls then merges when mergeability resolves from UNKNOWN', async () => {
    process.env['SUDO_GITHUB_MERGE_POLL_MS'] = '0';
    let views = 0;
    runCmdMock.mockImplementation((bin: string, args: string[]) => {
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        views++;
        return Promise.resolve(prView({ mergeable: views < 2 ? 'UNKNOWN' : 'MERGEABLE', statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
      }
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'merge') return Promise.resolve(ok(''));
      return Promise.resolve(ok(''));
    });
    const res = await githubMergePrTool.execute({}, ctx);
    expect(res.success).toBe(true);
    expect(views).toBeGreaterThan(1); // it re-polled
    expect(mergeWasCalled()).toBe(true);
  });

  it('refuses if mergeability stays UNKNOWN after polling', async () => {
    process.env['SUDO_GITHUB_MERGE_POLL_MS'] = '0';
    routePr(prView({ mergeable: 'UNKNOWN', statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
    const res = await githubMergePrTool.execute({}, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/unknown/i);
    expect(mergeWasCalled()).toBe(false);
  });
});

describe('github PR feature tools', () => {
  it('list_prs parses gh json into a summary', async () => {
    route((bin, args) => (bin === 'gh' && args[0] === 'pr' && args[1] === 'list'
      ? ok(JSON.stringify([{ number: 5, title: 'Fix', state: 'OPEN', headRefName: 'fix/x', isDraft: false }]))
      : ok('')));
    const res = await githubListPrsTool.execute({}, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/#5 \[OPEN\] Fix/);
  });

  it('pr_diff returns the diff', async () => {
    route((bin, args) => (bin === 'gh' && args[1] === 'diff' ? ok('diff --git a/x b/x\n+hi') : ok('')));
    const res = await githubPrDiffTool.execute({ pr: '5' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain('diff --git');
  });

  it('pr_comment posts a comment', async () => {
    route((bin, args) => (bin === 'gh' && args[1] === 'comment' ? ok('https://github.com/o/r/pull/5#c1') : ok('')));
    const res = await githubPrCommentTool.execute({ pr: '5', body: 'LGTM' }, ctx);
    expect(res.success).toBe(true);
    expect(runCmdMock.mock.calls.some((c) => c[0] === 'gh' && c[1][1] === 'comment')).toBe(true);
  });

  it('close_pr closes without merging', async () => {
    route((bin, args) => (bin === 'gh' && args[1] === 'close' ? ok('') : ok('')));
    const res = await githubClosePrTool.execute({ pr: '5' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/closed pr/i);
  });

  it('update_branch treats "not behind" as success (no-op)', async () => {
    route((bin, args) => (bin === 'gh' && args[1] === 'update-branch'
      ? err('the pull request is not behind the base branch', 1)
      : ok('')));
    const res = await githubUpdateBranchTool.execute({ pr: '5' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/already up to date/i);
  });
});

describe('github issue tools', () => {
  it('list_issues parses gh json', async () => {
    route((bin, args) => (bin === 'gh' && args[0] === 'issue' && args[1] === 'list'
      ? ok(JSON.stringify([{ number: 9, title: 'Bug', state: 'OPEN', labels: [{ name: 'bug' }] }]))
      : ok('')));
    const res = await githubListIssuesTool.execute({}, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/#9 \[OPEN\] Bug \[bug\]/);
  });

  it('create_issue parses the number/url', async () => {
    route((bin, args) => (bin === 'gh' && args[0] === 'issue' && args[1] === 'create' ? ok('https://github.com/o/r/issues/42') : ok('')));
    const res = await githubCreateIssueTool.execute({ title: 'New', body: 'b' }, ctx);
    expect(res.success).toBe(true);
    expect((res.data as { number: number }).number).toBe(42);
  });

  it('comment_issue posts a comment', async () => {
    route((bin, args) => (bin === 'gh' && args[0] === 'issue' && args[1] === 'comment' ? ok('') : ok('')));
    const res = await githubCommentIssueTool.execute({ number: '42', body: 'hi' }, ctx);
    expect(res.success).toBe(true);
    expect(runCmdMock.mock.calls.some((c) => c[0] === 'gh' && c[1][0] === 'issue' && c[1][1] === 'comment')).toBe(true);
  });

  it('close_issue closes (reversible)', async () => {
    route((bin, args) => (bin === 'gh' && args[0] === 'issue' && args[1] === 'close' ? ok('') : ok('')));
    const res = await githubCloseIssueTool.execute({ number: '42' }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/closed issue #42/i);
  });
});

describe('github.pr_status', () => {
  it('reports a green summary', async () => {
    route((bin, args) => (bin === 'gh' && args[1] === 'view'
      ? prView({ statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }] })
      : ok('')));
    const res = await githubPrStatusTool.execute({}, ctx);
    expect(res.success).toBe(true);
    expect((res.data as { green: boolean }).green).toBe(true);
    expect(res.output).toMatch(/GREEN/);
  });
});

describe('github.open_pr', () => {
  it('pushes then creates and parses the PR number', async () => {
    route((bin, args) => {
      if (bin === 'git' && args[0] === 'rev-parse') return ok('feature/x');
      if (bin === 'git' && args[0] === 'push') return ok('');
      if (bin === 'gh' && args[0] === 'pr' && args[1] === 'create') return ok('https://github.com/o/r/pull/77');
      return ok('');
    });
    const res = await githubOpenPrTool.execute({ title: 'My PR' }, ctx);
    expect(res.success).toBe(true);
    expect((res.data as { number: number }).number).toBe(77);
  });

  it('refuses when on the base branch', async () => {
    route((bin, args) => (bin === 'git' && args[0] === 'rev-parse' ? ok('main') : ok('')));
    const res = await githubOpenPrTool.execute({ title: 'x', base: 'main' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/feature branch/i);
  });
});
