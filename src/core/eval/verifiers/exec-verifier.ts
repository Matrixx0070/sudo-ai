/**
 * @file exec-verifier.ts
 * @description Code-execution BenchVerifier. Extracts a code block from the response,
 * appends a held-out test harness, and runs the combined script inside the project sandbox.
 *
 * Score = 1.0 if exit code is 0; 0.0 otherwise. (Partial-credit per-assertion can be added
 * later by parsing structured stdout markers.)
 *
 * Sandbox-availability degradation: when `bwrap` is missing OR runInSandbox throws an
 * EACCES/ENOENT we return `{ passed: false, score: 0, detail: 'sandbox unavailable' }` so
 * the verifier is safe to attach in environments without bubblewrap (the result is still a
 * failure — production CI MUST have bwrap installed for these tasks to score).
 */

import { spawnSync } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../../shared/logger.js';
import { DEFAULT_SANDBOX_POLICY, runInSandbox } from '../../sandbox/index.js';
import type { BenchTask, BenchVerifier, VerifierResult } from '../../shared/wave10-types.js';

const log = createLogger('eval:exec-verifier');

export type Language = 'python' | 'bash';

export interface ExecVerifierOptions {
  /** Language of the held-out test harness. Default 'python'. */
  language?: Language;
  /** Code appended to the agent's extracted block before execution (asserts, prints, exit codes). */
  heldOutTests: string;
  /** Per-run timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Override the regex used to extract the agent's code. Default matches ```python … ``` or bare ``` … ```. */
  codeBlockRegex?: RegExp;
}

const DEFAULT_PYTHON_RE = /```(?:python|py)?\s*\n([\s\S]*?)```/gi;
const DEFAULT_BASH_RE = /```(?:bash|sh)?\s*\n([\s\S]*?)```/gi;

export class ExecVerifier implements BenchVerifier {
  readonly type = 'exec';
  private readonly language: Language;
  private readonly heldOutTests: string;
  private readonly timeoutMs: number;
  private readonly codeBlockRegex: RegExp;

  constructor(opts: ExecVerifierOptions) {
    if (!opts.heldOutTests || opts.heldOutTests.trim().length === 0) {
      throw new Error('ExecVerifier: heldOutTests is required');
    }
    this.language = opts.language ?? 'python';
    this.heldOutTests = opts.heldOutTests;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.codeBlockRegex = opts.codeBlockRegex ?? (this.language === 'python' ? DEFAULT_PYTHON_RE : DEFAULT_BASH_RE);
  }

  async verify(_task: BenchTask, response: string): Promise<VerifierResult> {
    const code = extractLastCodeBlock(response, this.codeBlockRegex);
    if (!code) {
      return { passed: false, score: 0, detail: 'no code block found in response', type: this.type };
    }

    if (!isSandboxAvailable()) {
      return { passed: false, score: 0, detail: 'sandbox unavailable (bwrap not installed)', type: this.type };
    }

    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-verifier-'));
    try {
      const scriptName = this.language === 'python' ? 'script.py' : 'script.sh';
      const scriptPath = path.join(workspaceDir, scriptName);
      const fullScript = `${code}\n\n# --- held-out tests ---\n${this.heldOutTests}\n`;
      fs.writeFileSync(scriptPath, fullScript, { mode: 0o644 });

      const command = this.language === 'python'
        ? `python3 ${scriptName}`
        : `bash ${scriptName}`;

      const result = await runInSandbox({
        command,
        workspaceDir,
        // Use host network (skip `--unshare-net`) because unprivileged runners
        // (GitHub Actions, default Docker) lack CAP_NET_ADMIN, which makes bwrap's
        // loopback setup fail and corrupts the child's exit status. The verifier
        // controls the held-out test content, so network exposure is acceptable;
        // filesystem/PID/IPC isolation still applies.
        policy: { ...DEFAULT_SANDBOX_POLICY, network: 'host' },
        timeoutMs: this.timeoutMs,
      });

      const passed = result.exitCode === 0;
      const score = passed ? 1 : 0;
      const detail = passed
        ? 'all held-out tests passed'
        : trim(`exit=${result.exitCode} stderr=${result.stderr}`, 2_000);

      return { passed, score, detail, type: this.type };
    } catch (err) {
      log.warn({ err: String(err) }, 'ExecVerifier: runInSandbox threw — marking as failure');
      return {
        passed: false,
        score: 0,
        detail: trim(`sandbox error: ${String(err)}`, 2_000),
        type: this.type,
      };
    } finally {
      try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (also exported for direct unit testing)
// ---------------------------------------------------------------------------

export function extractLastCodeBlock(text: string, regex: RegExp): string | null {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) last = m[1];
  }
  return last;
}

let sandboxCheckCache: boolean | null = null;

/**
 * Returns true only when bwrap is installed AND can actually run a trivial command.
 * GHA / some Docker runners install bwrap but restrict unprivileged user namespaces
 * via AppArmor, causing it to fail at "setting up uid map". A `bwrap --version`
 * check returns 0 even in that case, which is why we also smoke-test `/bin/true`.
 */
export function isSandboxAvailable(): boolean {
  if (sandboxCheckCache !== null) return sandboxCheckCache;
  try {
    const ver = spawnSync('bwrap', ['--version'], { stdio: 'ignore' });
    if (ver.status !== 0) { sandboxCheckCache = false; return sandboxCheckCache; }
    const smokeArgs = [
      '--die-with-parent',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
    ];
    if (existsSync('/lib64')) smokeArgs.push('--ro-bind', '/lib64', '/lib64');
    smokeArgs.push('--proc', '/proc', '--dev', '/dev', '--unshare-pid', '--', '/usr/bin/true');
    const smoke = spawnSync('bwrap', smokeArgs, { stdio: 'ignore' });
    sandboxCheckCache = smoke.status === 0;
  } catch {
    sandboxCheckCache = false;
  }
  return sandboxCheckCache;
}

/** Test-only: reset the cached sandbox-availability flag. */
export function _resetSandboxCheckCache(): void {
  sandboxCheckCache = null;
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + ' …[truncated]';
}
