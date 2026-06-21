/**
 * @file src/core/self-build/review-pr.ts
 * @description Self-improvement loop → review PR.
 *
 * After the self-build orchestrator produces a validated commit on the
 * `self-build` branch, this surfaces it as a pull request FOR HUMAN REVIEW via
 * the zero-risk github connector (github.open_pr) — it never auto-merges
 * self-generated code. Opt-in via SUDO_SELF_BUILD_OPEN_PR (default OFF); the
 * whole path is also dormant unless SUDO_SELF_BUILD_MODE=1.
 */

import { createLogger } from '../shared/logger.js';
import { githubOpenPrTool } from '../tools/builtin/github/github.js';
import type { ToolContext } from '../tools/types.js';
import type { TickResult } from './orchestrator.js';

const log = createLogger('self-build:review-pr');

/** True when self-build should open a review PR for each committed improvement. */
export function selfBuildOpenPrEnabled(): boolean {
  const v = (process.env['SUDO_SELF_BUILD_OPEN_PR'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

export interface ReviewPrOutcome {
  ok: boolean;
  pr?: number;
  updated?: boolean;
  detail?: string;
}

/**
 * Push the self-build branch and open (or update) a PR to `main` for review.
 * Only acts on a `committed` tick result; never merges.
 */
export async function openSelfBuildReviewPr(
  cwd: string,
  result: TickResult,
  logger: unknown,
): Promise<ReviewPrOutcome> {
  if (result.status !== 'committed') {
    return { ok: false, detail: `not a committed result (${result.status})` };
  }
  const ctx = { sessionId: 'self-build', workingDir: cwd, config: {}, logger } as unknown as ToolContext;
  const sha8 = String(result.commitSha ?? '').slice(0, 8);
  const title = `self-build: ${result.message ?? `improvement ${sha8}`}`.slice(0, 120);
  const body = [
    '## Autonomous self-build improvement',
    '',
    `Commit: \`${result.commitSha ?? 'unknown'}\``,
    result.message ? `\n${result.message}\n` : '',
    '_Opened by the self-build loop for human review — not auto-merged._',
  ].join('\n');

  // github.open_pr pushes the current branch, then `gh pr create`.
  const open = await githubOpenPrTool.execute({ cwd, title, body, base: 'main' }, ctx);
  if (open.success) {
    const pr = (open.data as { number?: number })?.number;
    log.info({ pr }, 'self-build: opened review PR');
    return { ok: true, pr, updated: false };
  }
  // A PR already exists for the branch — the push inside open_pr still updated it.
  if (/already exists|a pull request for branch/i.test(open.output)) {
    log.info({}, 'self-build: review PR already open — branch updated');
    return { ok: true, updated: true };
  }
  log.warn({ detail: open.output }, 'self-build: failed to open review PR');
  return { ok: false, detail: open.output };
}
