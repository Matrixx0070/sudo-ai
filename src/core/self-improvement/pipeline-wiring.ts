/**
 * @file self-improvement/pipeline-wiring.ts
 * @description AL8.2 wiring — the standard compositions that turn the
 * pipeline's injected seams into REAL machinery:
 *
 *   f18Quarantine        — PR-bound text through the F18 inspector
 *                          (gdrive/quarantine inspectContent; invariant 2:
 *                          self-authored control-path text is untrusted)
 *   injectionScan        — promptPlugin's scan from the memory
 *                          injection-scanner (same scanner the workshop uses)
 *   createSandboxCodeValidator — code-patch validation: deterministic
 *                          path guards (protected paths + traversal refused
 *                          BEFORE any execution) then build/test commands run
 *                          through an injected sandboxed exec (trust-tier
 *                          runner at final composition). Fail-closed on a
 *                          missing/broken sandbox.
 *   generateLearningsDraft — the first GENERATOR: converts detectPatterns
 *                          output into a prompt-type ImprovementDraft, so
 *                          the failure-pattern learnings that today bypass
 *                          validation (engine writes LEARNINGS.md directly)
 *                          have a pipeline-shaped path. Engine cutover to
 *                          this path is a deliberate follow-up — this module
 *                          adds the path without changing live behavior.
 */

import path from 'node:path';
import { inspectContent, type InspectOptions } from '../gdrive/quarantine.js';
import { scanMemoryContent } from '../memory/injection-scanner.js';
import { isProtectedPath } from '../self-build/protected-paths.js';
import type { DetectedPatterns } from './pattern-detector.js';
import type { ImprovementDraft, PipelineDeps } from './pipeline.js';

// ---------------------------------------------------------------------------
// Quarantine + injection-scan adapters
// ---------------------------------------------------------------------------

/** The AL8.5 quarantine seam backed by the real F18 inspector. */
export function f18Quarantine(opts: InspectOptions = {}): NonNullable<PipelineDeps['quarantine']> {
  return async (text: string) => {
    const verdict = await inspectContent(text, opts);
    return verdict.verdict === 'clean'
      ? { ok: true, detail: `F18 clean (risk ${verdict.riskScore.toFixed(2)})` }
      : { ok: false, detail: `F18 HOLD (risk ${verdict.riskScore.toFixed(2)}): ${verdict.reasons.join(', ')}` };
  };
}

/** promptPlugin's scan seam backed by the memory injection scanner. */
export function injectionScan(): (text: string) => { ok: boolean; detail: string } {
  return (text: string) => {
    const r = scanMemoryContent(text, undefined, 'improvement-pipeline');
    return r.clean
      ? { ok: true, detail: 'injection scan clean' }
      : { ok: false, detail: `injection scan: ${r.reasons.join(', ')}` };
  };
}

// ---------------------------------------------------------------------------
// Sandbox code validator
// ---------------------------------------------------------------------------

export interface PatchFile {
  /** Repo-relative path. Absolute paths, traversal, and protected paths refuse. */
  path: string;
  content: string;
}

export interface CodePatchPayload {
  files: PatchFile[];
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxCodeValidatorDeps {
  /** Sandboxed command runner (trust-tier backend at final composition). */
  execInSandbox: (argv: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<SandboxExecResult>;
  /** Stages a repo copy with the patch applied; returns the workspace cwd. */
  prepareWorkspace: (files: PatchFile[]) => Promise<string>;
  /** Validation commands, in order. Default: typecheck then tests. */
  commands?: string[][];
  timeoutMs?: number;
}

const DEFAULT_COMMANDS: string[][] = [
  ['npx', 'tsc', '--noEmit'],
  ['npx', 'vitest', 'run'],
];

/**
 * Build the code-patch plugin's sandboxValidate seam. Deterministic guards
 * run BEFORE any staging or execution: every patch file must be repo-relative,
 * traversal-free, and outside the protected-path list — a patch that touches
 * a frozen surface never reaches the sandbox at all (AL8.5).
 */
export function createSandboxCodeValidator(
  deps: SandboxCodeValidatorDeps,
): (draft: ImprovementDraft) => Promise<{ ok: boolean; detail: string }> {
  const commands = deps.commands ?? DEFAULT_COMMANDS;
  return async (draft: ImprovementDraft) => {
    const payload = draft.payload as Partial<CodePatchPayload> | undefined;
    if (!payload || !Array.isArray(payload.files) || payload.files.length === 0) {
      return { ok: false, detail: 'code-patch payload must be { files: [{ path, content }] }' };
    }
    for (const f of payload.files) {
      if (typeof f?.path !== 'string' || typeof f?.content !== 'string') {
        return { ok: false, detail: 'each patch file needs string path + content' };
      }
      if (path.isAbsolute(f.path) || f.path.split(/[\\/]/).includes('..')) {
        return { ok: false, detail: `patch path escapes the repo: "${f.path}"` };
      }
      if (isProtectedPath(f.path)) {
        return { ok: false, detail: `patch touches a protected path: "${f.path}" — refused before any execution` };
      }
    }

    let cwd: string;
    try {
      cwd = await deps.prepareWorkspace(payload.files as PatchFile[]);
    } catch (err) {
      return { ok: false, detail: `workspace staging failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    for (const argv of commands) {
      let result: SandboxExecResult;
      try {
        result = await deps.execInSandbox(argv, { cwd, timeoutMs: deps.timeoutMs });
      } catch (err) {
        return {
          ok: false,
          detail: `sandbox unavailable for "${argv.join(' ')}" — blocking (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout).slice(-400);
        return { ok: false, detail: `"${argv.join(' ')}" exited ${result.exitCode}: ${tail}` };
      }
    }
    return { ok: true, detail: `sandbox validation passed (${commands.length} command(s))` };
  };
}

// ---------------------------------------------------------------------------
// First generator: failure-pattern learnings → prompt artifact
// ---------------------------------------------------------------------------

/**
 * Convert detectPatterns output into a prompt-type draft (the LEARNINGS.md
 * block, pipeline-shaped). Returns null when there is nothing worth
 * proposing — an empty improvement is not an improvement.
 */
export function generateLearningsDraft(patterns: DetectedPatterns): ImprovementDraft | null {
  const lines: string[] = [];
  for (const t of patterns.failingTools) {
    lines.push(
      `- Tool \`${t.name}\` fails ${(t.failRate * 100).toFixed(0)}% of the time ` +
        `(${t.failures}/${t.calls} calls): verify inputs and prefer alternatives until it stabilises.`,
    );
  }
  for (const f of patterns.badFeedbackTypes) {
    lines.push(`- Task type "${f.taskType}" draws repeated bad feedback: slow down and confirm scope first.`);
  }
  if (lines.length === 0) return null;

  return {
    type: 'prompt',
    title: `Learnings update (${patterns.analysedAt.slice(0, 10)}): ${lines.length} rule(s)`,
    rationale:
      `detectPatterns found ${patterns.failingTools.length} failing tool(s) and ` +
      `${patterns.badFeedbackTypes.length} bad-feedback task type(s) (health ${patterns.healthScore}/100).`,
    evalPlan:
      'Bench the system prompt with and without the new rules on the agent-task suite; ' +
      'adopt only if pass-rate does not regress.',
    payload: `## Learned failure patterns (${patterns.analysedAt.slice(0, 10)})\n${lines.join('\n')}\n`,
  };
}
