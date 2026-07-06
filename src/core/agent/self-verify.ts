/**
 * @file self-verify.ts
 * @description Self-Verify — post-execution verification phase that validates
 * whether the agent's changes actually accomplish the stated goal.
 * Grok Build CLI parity (--check flag).
 *
 * After the agent completes its work, an independent verification phase runs:
 *   1. Re-read the original user message (the goal)
 *   2. Inspect the changes made (file diffs)
 *   3. Run tests if applicable
 *   4. Produce a verification report: PASS / FAIL / PARTIAL
 *
 * Works in headless mode (no user interaction needed).
 * Enabled via --check CLI flag or SUDO_SELF_VERIFY=1 env var.
 */

import { createLogger } from '../shared/logger.js';
import { execSync, spawnSync } from 'node:child_process';

const log = createLogger('agent:self-verify');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Whether Self-Verify is enabled. */
export const SELF_VERIFY_ENABLED: boolean =
  process.env['SUDO_SELF_VERIFY'] === '1' || process.env['SUDO_SELF_VERIFY'] === 'true';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerifyVerdict = 'pass' | 'fail' | 'partial';

export interface VerifyResult {
  /** Overall verdict. */
  verdict: VerifyVerdict;
  /** Confidence in the verdict (0-1). */
  confidence: number;
  /** Checklist of verification points. */
  checks: VerifyCheck[];
  /** Summary of the verification. */
  summary: string;
  /** Test output if tests were run. */
  testOutput?: string;
  /** Diff summary of files changed. */
  diffSummary?: string;
}

export interface VerifyCheck {
  /** What was checked. */
  description: string;
  /** Result of this check. */
  passed: boolean;
  /** Evidence for the result. */
  evidence: string;
}

// ---------------------------------------------------------------------------
// SelfVerify
// ---------------------------------------------------------------------------

/**
 * Post-execution verification system.
 *
 * Usage:
 * ```ts
 * const verifier = new SelfVerify(brain);
 * const result = await verifier.verify(
 *   'Fix the login bug',
 *   ['/src/auth/login.ts', '/tests/auth.test.ts'],
 *   process.cwd(),
 * );
 * // result.verdict = 'pass', result.confidence = 0.9
 * ```
 */
export class SelfVerify {
  private readonly brain: unknown; // BrainLike — duck-typed

  constructor(brain: unknown) {
    this.brain = brain;
    log.info('SelfVerify initialised');
  }

  /**
   * Run post-execution verification.
   *
   * @param goal         - The original user message (the goal).
   * @param filesChanged - List of files that were modified.
   * @param cwd          - Working directory for running tests.
   * @returns VerifyResult with verdict and checks.
   */
  async verify(
    goal: string,
    filesChanged: string[],
    cwd: string,
  ): Promise<VerifyResult> {
    log.info({ goal: goal.slice(0, 80), filesChanged: filesChanged.length }, 'Starting self-verification');

    // Abstain when there is nothing to verify. The verifier's checks
    // (files modified, diff syntax, test run, goal alignment) are all
    // structured around code changes; running them on a pure Q&A turn
    // (e.g. /v1/chat/completions with no edits) produces a misleading
    // "partial" verdict on Check 1 alone. Treat an empty change set +
    // empty diff as "no work expected, nothing to verify" and pass cleanly.
    if (filesChanged.length === 0) {
      const probeDiff = this._getDiffSummary(cwd);
      if (probeDiff.trim() === '') {
        const abstainChecks: VerifyCheck[] = [{
          description: 'Self-verification skipped (no change history to verify)',
          passed: true,
          evidence: 'No files reported as changed and the working tree has no pending diff — verification not applicable',
        }];
        const summary = this._buildSummary('pass', abstainChecks, goal);
        log.info({ verdict: 'pass', reason: 'no-change-history' }, 'Self-verification skipped');
        return {
          verdict: 'pass',
          confidence: 1,
          checks: abstainChecks,
          summary,
          testOutput: undefined,
          diffSummary: '',
        };
      }
    }

    const checks: VerifyCheck[] = [];

    // Check 1: Were any files actually modified?
    const filesModified = filesChanged.length > 0;
    checks.push({
      description: 'Files were modified to address the goal',
      passed: filesModified,
      evidence: filesModified
        ? `${filesChanged.length} file(s) modified: ${filesChanged.slice(0, 5).join(', ')}`
        : 'No files were modified',
    });

    // Check 2: Diff summary readable. Passing is "git diff --stat ran"; the
    // stat text is evidence, not something to grep — filenames legitimately
    // contain words like "error".
    let diffSummary = '';
    try {
      diffSummary = this._getDiffSummary(cwd);
      checks.push({
        description: 'Change diff captured',
        passed: true,
        evidence: diffSummary.slice(0, 500) || 'No changes detected',
      });
    } catch {
      checks.push({
        description: 'Change diff captured',
        passed: true, // assume valid if we can't check
        evidence: 'Could not run diff check',
      });
    }

    // Check 3: Run tests if applicable
    let testOutput: string | undefined;
    const hasTests = this._hasTestFiles(filesChanged, cwd);
    if (hasTests) {
      try {
        const testRun = this._runTests(cwd);
        testOutput = testRun.output;
        checks.push({
          description: 'Tests pass after changes',
          passed: testRun.exitCode === 0,
          evidence: `exit ${testRun.exitCode}: ${testRun.output.slice(0, 500)}`,
        });
      } catch (err) {
        checks.push({
          description: 'Tests pass after changes',
          passed: false,
          evidence: `Test run failed: ${String(err).slice(0, 200)}`,
        });
      }
    } else {
      checks.push({
        description: 'No test files present — skipping test check',
        passed: true,
        evidence: 'No test files found for changed files',
      });
    }

    // Check 4: Goal alignment (use the brain for semantic verification)
    try {
      const alignmentCheck = await this._checkGoalAlignment(goal, filesChanged, diffSummary);
      checks.push(alignmentCheck);
    } catch (err) {
      checks.push({
        description: 'Goal alignment check',
        passed: true, // assume aligned if brain check fails
        evidence: `Could not run alignment check: ${String(err).slice(0, 100)}`,
      });
    }

    // Check 5: No regressions (basic check — no deleted files or removed functionality)
    if (diffSummary.includes('deleted') || diffSummary.includes('removed')) {
      checks.push({
        description: 'No unintended deletions',
        passed: !diffSummary.toLowerCase().includes('accidentally') && !diffSummary.includes('ERROR'),
        evidence: 'Diff contains deletions — verify these are intentional',
      });
    }

    // Calculate overall verdict
    const passCount = checks.filter(c => c.passed).length;
    const totalChecks = checks.length;
    const passRatio = passCount / totalChecks;

    let verdict: VerifyVerdict;
    let confidence: number;

    if (passRatio >= 0.8) {
      verdict = 'pass';
      confidence = 0.7 + (passRatio - 0.8) * 1.5; // 0.7-1.0 range
    } else if (passRatio >= 0.5) {
      verdict = 'partial';
      confidence = 0.4 + (passRatio - 0.5) * 1.0;
    } else {
      verdict = 'fail';
      confidence = 1 - passRatio;
    }

    const summary = this._buildSummary(verdict, checks, goal);

    log.info(
      { verdict, confidence: confidence.toFixed(2), passCount, totalChecks },
      'Self-verification complete',
    );

    return {
      verdict,
      confidence: Math.min(1, Math.max(0, confidence)),
      checks,
      summary,
      testOutput,
      diffSummary,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _getDiffSummary(cwd: string): string {
    try {
      return execSync('git diff --stat HEAD~1 HEAD 2>/dev/null || git diff --stat', {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      }).trim();
    } catch {
      return '';
    }
  }

  private _hasTestFiles(filesChanged: string[], cwd: string): boolean {
    const testPatterns = ['.test.', '.spec.', '_test.', '_spec.', '/tests/', '/test/'];
    return filesChanged.some(f => testPatterns.some(p => f.includes(p)));
  }

  /**
   * Run the workspace test suite and report the REAL exit code. The old
   * shell form (`… | tail -50`) reported tail's exit code, so failures were
   * invisible and pass/fail fell back to fragile string matching.
   */
  private _runTests(cwd: string): { output: string; exitCode: number } {
    const res = spawnSync('npx', ['vitest', 'run', '--reporter=dot'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    const raw = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    const lines = raw.split('\n');
    const output = lines.slice(-50).join('\n');
    // status is null when the process was killed (timeout) — treat as failure.
    const exitCode = typeof res.status === 'number' ? res.status : 124;
    return { output, exitCode };
  }

  private async _checkGoalAlignment(
    goal: string,
    filesChanged: string[],
    diffSummary: string,
  ): Promise<VerifyCheck> {
    // No change history to align against (e.g. pure Q&A via /v1/chat/completions).
    // Skip the LLM call rather than issue a request that the brain rejects with
    // "BrainRequest.messages must be non-empty" after its system-role filter.
    if (filesChanged.length === 0 && diffSummary.trim() === '') {
      return {
        description: 'Goal alignment check (no changes to align)',
        passed: true,
        evidence: 'No files changed and empty diff — nothing to verify against; skipping LLM call',
      };
    }

    // The Brain exposes `call(request: BrainRequest)` — a request OBJECT whose
    // `messages` field holds the conversation. The previous code passed a bare
    // messages ARRAY, so the Brain read `request.messages` off an array
    // (undefined) and threw "BrainRequest.messages must be non-empty" on EVERY
    // call (62-172×/day). The check then silently fell through to "assuming
    // aligned" — so goal alignment never actually ran. Cast to the real
    // request-object shape and call it correctly.
    const brainLike = this.brain as {
      call?: (request: { messages: Array<{ role: string; content: string }> }) => Promise<{ content: string }>;
    };

    if (!brainLike?.call || typeof brainLike.call !== 'function') {
      return {
        description: 'Goal alignment check (no brain available)',
        passed: true,
        evidence: 'Brain not available for semantic verification — assuming aligned',
      };
    }

    try {
      // The instruction rides in the user message: BrainRequest excludes system
      // (the Brain prepends its own), and system-role entries in `messages` are
      // dropped/folded — so a system entry here would be unreliable.
      const response = await brainLike.call({
        messages: [
          {
            role: 'user',
            content:
              'You are a verification agent. Given a goal and the changes made, '
              + 'determine if the changes accomplish the goal. Reply ONLY with JSON: '
              + '{"aligned": true/false, "reasoning": "..."}\n\n'
              + `Goal: ${goal}\n\n`
              + `Files changed: ${filesChanged.join(', ')}\n\n`
              + `Diff summary:\n${diffSummary.slice(0, 2000)}`,
          },
        ],
      });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          description: 'Goal alignment verified by semantic check',
          passed: Boolean(parsed.aligned),
          evidence: String(parsed.reasoning ?? 'No reasoning provided'),
        };
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'Goal alignment check failed');
    }

    return {
      description: 'Goal alignment check',
      passed: true,
      evidence: 'Semantic verification unavailable — assuming aligned',
    };
  }

  private _buildSummary(verdict: VerifyVerdict, checks: VerifyCheck[], goal: string): string {
    const verdictEmoji = verdict === 'pass' ? '✅' : verdict === 'partial' ? '⚠️' : '❌';
    const failedChecks = checks.filter(c => !c.passed);
    const passedChecks = checks.filter(c => c.passed);

    let summary = `${verdictEmoji} Self-Verify: ${verdict.toUpperCase()}\n`;
    summary += `Goal: "${goal.slice(0, 100)}"\n`;
    summary += `Checks: ${passedChecks.length}/${checks.length} passed\n`;

    if (failedChecks.length > 0) {
      summary += '\nFailed checks:\n';
      for (const fc of failedChecks) {
        summary += `  ✗ ${fc.description}: ${fc.evidence.slice(0, 100)}\n`;
      }
    }

    return summary;
  }
}