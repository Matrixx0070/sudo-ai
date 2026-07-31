/**
 * @file ladder-rung3.ts
 * @description Rung 3 — code unit-test (ADR-0002): the route generates code,
 * and a FIXED unit-test suite decides pass/fail. Binary per task, code-graded,
 * no judge.
 *
 * The generated code is untrusted model output, so it never runs on the host:
 * execution goes through the Spec-8 hardened Docker backend (cap-drop ALL,
 * no-new-privileges, read-only rootfs, --network none, pids/memory capped) —
 * the same tier every untrusted eval turn uses. That is exactly the "existing
 * bwrap/Docker sandbox" grader ADR-0002 specifies, and it is why this rung
 * belongs on the eval-sandbox platform rather than in a standalone harness.
 *
 * Admission (ADR-0002): rung 3 >= 85% (n>=30) gates code-task routing
 * (skill.eval, PTC, self-modify authorship).
 *
 * INJECTION NOTE: `expect.command` is shell-interpreted inside the container,
 * but it comes ONLY from the checked-in golden set — never from model output.
 * The model's code is written to a FILE and is never interpolated into the
 * command string, so a hostile completion cannot reach the shell. It would
 * still be confined (no network, cap-drop ALL, read-only rootfs) if it did.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../shared/logger.js';
import type { GradeOutcome } from './ladder-graders.js';

const log = createLogger('eval:ladder-rung3');

/** Result of running one generated solution against its test suite. */
export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SandboxExec = (opts: {
  command: string;
  workspaceDir: string;
  timeoutMs: number;
}) => Promise<SandboxExecResult>;

/**
 * Extract the code the model actually wrote. Prefers a fenced block (the
 * common shape), falling back to the whole reply when the model emitted bare
 * code. Language tags are stripped; the LONGEST fenced block wins, since
 * models often precede the solution with a short illustrative snippet.
 */
export function extractCode(reply: string): string | null {
  const fences = [...reply.matchAll(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  if (fences.length > 0) {
    const best = fences.reduce((a, b) => (b.trim().length > a.trim().length ? b : a));
    return best.trim() === '' ? null : best;
  }
  const bare = reply.trim();
  if (bare === '') return null;
  // A reply with no fence and no code-ish token is prose, not a solution.
  return /[{};=()]|function |const |let |def /.test(bare) ? bare : null;
}

/** Default executor: the Spec-8 hardened Docker tier (untrusted-grade). */
export const dockerSandboxExec: SandboxExec = async ({ command, workspaceDir, timeoutMs }) => {
  const { dockerBackend } = await import('../../sandbox/backends/docker-backend.js');
  return dockerBackend.run({
    command,
    workspaceDir,
    timeoutMs,
    policy: {
      enabled: true,
      network: 'none', // generated code never gets a network
      cpuSeconds: 20,
      memoryMB: 4096, // >= 4096: below this Node cannot reserve its pointer cage
    } as never,
  });
};

export interface Rung3Expect {
  /** File the generated solution is written to, e.g. "solution.js". */
  entry: string;
  /** Fixed test suite source, written beside the solution. */
  test: string;
  /** Command run inside the sandbox; non-zero exit = FAIL. */
  command: string;
}

/**
 * Human-readable reason a suite failed. Node prints the assertion, then a
 * stack, then a `Node.js v20.x` footer — so naively tailing the output yields
 * the version banner, not the diagnosis (observed live). Prefer the first
 * error-ish line and fall back to the last non-banner line.
 */
export function failureSummary(res: SandboxExecResult): string {
  const lines = `${res.stderr}\n${res.stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^Node\.js v\d/.test(l));
  // Node echoes the offending SOURCE LINE before the diagnosis ("throw new
  // AssertionError(obj);" — observed live), so drop code echoes and stack
  // frames and prefer a line that reads like a message: "<Name>Error...: ...".
  const prose = lines.filter(
    (l) => !l.startsWith('throw ') && !l.startsWith('at ') && !l.endsWith(';') && !l.startsWith('^'),
  );
  const errish =
    prose.find((l) => /^[A-Za-z_]*Error\b[^]*:/.test(l)) ??
    prose.find((l) => /(expected|Cannot find|is not a function|undefined)/i.test(l));
  const pick = errish ?? prose[prose.length - 1] ?? lines[lines.length - 1] ?? '';
  return pick === '' ? '' : `: ${pick.slice(0, 160)}`;
}

/** Narrow + validate a rung-3 `expect` descriptor. */
export function parseRung3Expect(expect: Record<string, unknown>): Rung3Expect | string {
  const entry = expect['entry'];
  const test = expect['test'];
  const command = expect['command'];
  for (const [k, v] of Object.entries({ entry, test, command })) {
    if (typeof v !== 'string' || v === '') return `rung-3 expect.${k} must be a non-empty string`;
  }
  for (const key of Object.keys(expect)) {
    if (!['entry', 'test', 'command'].includes(key)) return `unknown rung-3 expect key '${key}'`;
  }
  // Path containment: a golden set is trusted input, but a typo'd traversal
  // would write outside the throwaway workspace — refuse rather than escape.
  for (const p of [entry as string, 'test-suite']) {
    if (p.includes('..') || p.startsWith('/')) return `rung-3 entry must be a relative in-workspace path`;
  }
  return { entry: entry as string, test: test as string, command: command as string };
}

/**
 * Grade one rung-3 item: write the model's code + the fixed test suite into a
 * throwaway workspace, run the suite in the sandbox, and pass iff it exits 0.
 * The workspace is always removed, including on failure.
 */
export async function gradeRung3(
  expect: Record<string, unknown>,
  reply: string,
  exec: SandboxExec = dockerSandboxExec,
): Promise<GradeOutcome> {
  const parsed = parseRung3Expect(expect);
  if (typeof parsed === 'string') return { passed: false, detail: parsed };

  const code = extractCode(reply);
  if (code === null) return { passed: false, detail: 'no code in reply' };

  const dir = mkdtempSync(join(tmpdir(), 'ladder-r3-'));
  try {
    writeFileSync(join(dir, parsed.entry), code);
    writeFileSync(join(dir, 'test-suite.js'), parsed.test);
    const res = await exec({ command: parsed.command, workspaceDir: dir, timeoutMs: 60_000 });
    if (res.exitCode === 0) return { passed: true, detail: 'test suite passed' };
    return { passed: false, detail: `exit ${res.exitCode}${failureSummary(res)}` };
  } catch (err) {
    // A sandbox failure is a FAILED item, not a crashed run — same contract as
    // an unreachable route in ladder.ts.
    log.warn({ err: String(err) }, 'rung-3 sandbox execution failed');
    return { passed: false, detail: `sandbox error: ${String(err).slice(0, 160)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
