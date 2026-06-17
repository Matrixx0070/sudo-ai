/**
 * @file brain-verifier-exec.ts
 * @description Test-execution verifier for the tree-search orchestrator
 * (#240). Stage 2 of the kimi+glm Mythos-beating brain architecture,
 * PR #241.
 *
 * Replaces the stub `defaultVerifier` in brain-tree-search.ts with a
 * real algorithmic judge: extract the candidate's code, drop it into a
 * scratch workspace, run a caller-supplied test command inside the
 * existing bwrap sandbox, score by exit code.
 *
 * Returned function is shape-compatible with TreeSearchOpts.verifier, so
 * callers wire it in as:
 *
 *   const verifier = makeExecVerifier({
 *     testCommand: 'node --test test.mjs',
 *     candidateFile: 'solution.mjs',
 *   });
 *   runTreeSearch(brain, request, { verifier, breadth: 3 });
 *
 * Design points:
 *   - Caller owns the test command. The verifier doesn't try to infer
 *     "what's a test" — that's where the SWE-bench / Devin / Mythos
 *     advantage comes from: the test suite IS the spec, fed in by the
 *     caller who knows the task.
 *   - Code is run inside runInSandbox (bwrap process isolation,
 *     network: 'none' by default) so a hostile candidate can't read
 *     host files or call out. Caller can override the policy.
 *   - Code extraction is permissive: prefers fenced blocks, falls back
 *     to the raw content if no fence is present. LLMs that follow a
 *     "no markdown" instruction emit raw code; tree-search candidates
 *     from a debate may emit either.
 *   - Scoring: exit 0 → 1.0; non-zero → 0.0 with stderr/stdout tail
 *     baked into the Reflexion reason so the next candidate sees the
 *     concrete failure mode (line, assertion, error type).
 *   - The Reflexion-aware feedback loop is what makes this verifier
 *     worth more than a pass/fail counter — failed candidates teach
 *     the next round what NOT to repeat.
 *
 * What this PR is NOT:
 *   - Sympy/Z3 symbolic verifier (#242)
 *   - Search/citation cross-check verifier (#243)
 *   - Automatic test generation. The caller writes the test file
 *     content via opts.testFiles, or pre-stages a directory.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { runInSandbox } from '../sandbox/sandbox-runner.js';
import type { SandboxPolicy } from '../sandbox/sandbox-types.js';
import type { BrainResponse, BrainRequest } from './types.js';
import type { VerifierResult } from './brain-tree-search.js';

const log = createLogger('brain-verifier-exec');

/** Default sandbox policy — no network, conservative ulimits. */
const DEFAULT_POLICY: SandboxPolicy = {
  enabled: true,
  network: 'none',
  cpuSeconds: 15,
  memoryMB: 512,
  maxFileMB: 50,
};

/** Default wall-clock cap for a single verifier run. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Default filename to write the extracted candidate into. */
const DEFAULT_CANDIDATE_FILE = 'candidate.txt';

/** Options for makeExecVerifier. */
export interface ExecVerifierOpts {
  /**
   * Shell command run inside the sandbox after the candidate is
   * written. e.g. `node --test test.mjs`, `pytest -q tests/`,
   * `bash run.sh`. Exit code 0 = pass.
   */
  testCommand: string;
  /**
   * Filename (relative to the scratch workspace) to write the
   * extracted candidate code into. Default: `candidate.txt`.
   */
  candidateFile?: string;
  /**
   * Extra files to pre-stage in the scratch workspace before each
   * candidate runs. Keys are paths (relative to the workspace);
   * values are the file content as strings. Use this to drop in the
   * test runner / fixture / package.json the testCommand expects.
   */
  testFiles?: Record<string, string>;
  /**
   * Override the sandbox policy. Merged onto DEFAULT_POLICY. Use to
   * loosen the network gate for verifiers that need to call out
   * (e.g. integration tests), or to bump cpuSeconds for slow suites.
   */
  policy?: Partial<SandboxPolicy>;
  /**
   * Per-run wall-clock cap in ms. Default 30000.
   */
  timeoutMs?: number;
}

/**
 * Extract code from a candidate response. Prefers the FIRST fenced
 * block (```lang ... ```), falls back to the raw stripped content if no
 * fence is present. Returns '' when the content is empty so the caller
 * can score it as a no-op.
 *
 * Exported for unit-testing — the orchestrator never imports it
 * directly, but the round-trip through fence extraction → exec is
 * subtle enough to want isolated coverage.
 */
export function extractCodeFromCandidate(content: string): string {
  const trimmed = content.trim();
  if (trimmed === '') return '';
  // Match the first fenced block. Optional language tag, optional
  // trailing whitespace. Multiline-dot via [\s\S] keeps us off the
  // /s flag for broader node compatibility.
  const fenceMatch = trimmed.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/);
  if (fenceMatch && typeof fenceMatch[1] === 'string') {
    return fenceMatch[1].trimEnd();
  }
  // No fence — assume the model followed a "no markdown" instruction
  // and the entire payload is raw code.
  return trimmed;
}

/**
 * Build a Reflexion-ready failure reason from sandbox output. Trims to
 * a soft cap so a 10-MB stack trace doesn't blow the next candidate's
 * prompt. Prefers stderr (where assertion failures usually land) but
 * falls back to stdout when stderr is empty.
 */
function buildFailureReason(stdout: string, stderr: string, exitCode: number): string {
  const MAX = 600;
  const primary = stderr.trim() !== '' ? stderr : stdout;
  const tail = primary.length > MAX ? `…${primary.slice(-MAX)}` : primary;
  return `test command exited ${exitCode}: ${tail.trim()}`;
}

/**
 * Returned verifier function — async, signature matches
 * `TreeSearchOpts.verifier`. Use via:
 *   const v = makeExecVerifier({ testCommand: '…' });
 *   runTreeSearch(brain, req, { verifier: v });
 *
 * The verifier creates a fresh scratch workspace per candidate so a
 * destructive test (e.g. one that writes garbage files) cannot leak
 * state to the next candidate. Workspace is removed on every exit
 * path (success, failure, throw).
 */
export function makeExecVerifier(
  opts: ExecVerifierOpts,
): (candidate: BrainResponse, request: BrainRequest) => Promise<VerifierResult> {
  if (!opts.testCommand || opts.testCommand.trim() === '') {
    throw new Error('makeExecVerifier: testCommand is required');
  }
  const candidateFile = opts.candidateFile ?? DEFAULT_CANDIDATE_FILE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const policy: SandboxPolicy = { ...DEFAULT_POLICY, ...opts.policy };
  const testFiles = opts.testFiles ?? {};

  return async function execVerify(candidate, _request) {
    const code = extractCodeFromCandidate(candidate.content ?? '');
    if (code === '') {
      return { score: 0.0, reason: 'verifier: no code extracted from candidate' };
    }

    const workspaceDir = await mkdtemp(join(tmpdir(), 'sudo-brain-verify-'));
    try {
      // Write candidate + any pre-staged test files. All paths are
      // resolved relative to workspaceDir so a candidate string like
      // "../etc/passwd" stays inside the scratch dir on systems where
      // bwrap binds the workspace as the root.
      await writeFile(join(workspaceDir, candidateFile), code, 'utf-8');
      for (const [name, body] of Object.entries(testFiles)) {
        await writeFile(join(workspaceDir, name), body, 'utf-8');
      }

      const result = await runInSandbox({
        command: opts.testCommand,
        workspaceDir,
        policy,
        timeoutMs,
      });

      if (result.exitCode === 0) {
        log.info({ candidateFile, exitCode: 0 }, 'exec-verifier: PASS');
        return { score: 1.0 };
      }
      const reason = buildFailureReason(result.stdout, result.stderr, result.exitCode);
      log.info({ exitCode: result.exitCode, reasonLen: reason.length }, 'exec-verifier: FAIL');
      return { score: 0.0, reason };
    } catch (err) {
      // A sandbox-runner throw (timeout, bwrap missing, etc.) is itself
      // a verification failure. Surface it through the Reflexion log
      // so the next candidate's prompt sees it.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'exec-verifier: throw');
      return { score: 0.0, reason: `verifier exec error: ${msg}` };
    } finally {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
