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

import {
  GITHUB_TOOLS,
  githubCommitTool,
  githubMergePrTool,
  githubPrStatusTool,
  githubOpenPrTool,
  gitHubToolsEnabled,
} from '../../src/core/tools/builtin/github/github.js';
import { registerGitHubTools } from '../../src/core/tools/builtin/github/index.js';
import type { ToolContext } from '../../src/core/tools/types.js';

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
  delete process.env['SUDO_GITHUB_TOOLS'];
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
    expect(GITHUB_TOOLS.length).toBe(5);
  });
});

describe('github.commit', () => {
  it('stages, commits, returns sha + branch', async () => {
    route((bin, args) => {
      if (args[0] === 'add') return ok('');
      if (args[0] === 'status') return ok(' M file.ts');
      if (args[0] === 'commit') return ok('');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok('abc1234deadbeef');
      if (args[0] === 'rev-parse') return ok('feature/x');
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
      if (args[0] === 'commit') return err('hook rejected');
      return ok('');
    });
    const res = await githubCommitTool.execute({ message: 'm' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/git commit failed/i);
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
