/**
 * Self-improvement loop → review PR wiring. github.open_pr is stubbed so we test
 * the mapping logic (committed → open/update review PR; never merges) without gh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { openExec } = vi.hoisted(() => ({ openExec: vi.fn() }));
vi.mock('../../src/core/tools/builtin/github/github.js', () => ({
  githubOpenPrTool: { execute: openExec },
}));

import { openSelfBuildReviewPr, selfBuildOpenPrEnabled } from '../../src/core/self-build/review-pr.js';
import type { TickResult } from '../../src/core/self-build/orchestrator.js';

beforeEach(() => {
  openExec.mockReset();
  delete process.env['SUDO_SELF_BUILD_OPEN_PR'];
});

describe('self-build review-pr', () => {
  it('selfBuildOpenPrEnabled parses the flag', () => {
    for (const v of ['1', 'true', 'on', 'YES']) { process.env['SUDO_SELF_BUILD_OPEN_PR'] = v; expect(selfBuildOpenPrEnabled()).toBe(true); }
    for (const v of ['0', 'false', '']) { process.env['SUDO_SELF_BUILD_OPEN_PR'] = v; expect(selfBuildOpenPrEnabled()).toBe(false); }
    delete process.env['SUDO_SELF_BUILD_OPEN_PR']; expect(selfBuildOpenPrEnabled()).toBe(false);
  });

  it('opens a review PR for a committed result', async () => {
    openExec.mockResolvedValue({ success: true, output: 'Opened PR #88', data: { number: 88 } });
    const r = await openSelfBuildReviewPr('/repo', { status: 'committed', commitSha: 'abc123', message: 'fix bug' } as TickResult, {});
    expect(r.ok).toBe(true);
    expect(r.pr).toBe(88);
    const arg = openExec.mock.calls[0][0] as { base: string; title: string };
    expect(arg.base).toBe('main');
    expect(arg.title).toMatch(/^self-build:/);
  });

  it('treats an existing PR as updated (not an error)', async () => {
    openExec.mockResolvedValue({ success: false, output: 'gh pr create failed: a pull request for branch "self-build" already exists' });
    const r = await openSelfBuildReviewPr('/repo', { status: 'committed', commitSha: 'abc' } as TickResult, {});
    expect(r.ok).toBe(true);
    expect(r.updated).toBe(true);
  });

  it('no-ops for a non-committed result (never opens a PR)', async () => {
    const r = await openSelfBuildReviewPr('/repo', { status: 'no-action' } as TickResult, {});
    expect(r.ok).toBe(false);
    expect(openExec).not.toHaveBeenCalled();
  });

  it('reports failure when open_pr genuinely errors', async () => {
    openExec.mockResolvedValue({ success: false, output: 'gh pr create failed: boom' });
    const r = await openSelfBuildReviewPr('/repo', { status: 'committed', commitSha: 'abc' } as TickResult, {});
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/boom/);
  });
});
