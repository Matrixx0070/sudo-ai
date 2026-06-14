/**
 * @file workflows/executor.ts
 * @description Validation, condition evaluation, and shell execution for the
 * Lobster workflow engine.
 *
 * Security:
 *   - spawn() is always called with an argv array (never shell:true)
 *   - Step IDs validated against /^[a-z0-9_-]+$/
 *   - Commands containing $(), backticks, or pipe chars are rejected
 *   - Condition expressions evaluated via safe token walk (no eval)
 */

import { spawn } from 'child_process';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { WorkflowStep, Workflow, StepResult } from './types.js';

const log = createLogger('workflows:executor');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEP_ID_RE = /^[a-z0-9_-]+$/;
const DANGEROUS_RE = /\$\(|`|\|/;
// Extended check: also blocks shell metacharacters when validating stdin
const STDIN_DANGEROUS_RE = /\$\(|`|\||;|&|>|<|\n/;

/** Field of a StepResult that the template engine is allowed to expand to text. */
const TEMPLATE_FIELDS: ReadonlySet<keyof StepResult> = new Set<keyof StepResult>([
  'stdout',
  'stderr',
  'exitCode',
  'status',
  'durationMs',
]);

/**
 * Regex for `{{steps.<id>.<field>}}` (no surrounding whitespace).
 *
 * The id capture is intentionally lowercase-only to match `STEP_ID_RE`. If that
 * schema is ever widened to accept uppercase ids, this regex must widen with it
 * — otherwise references like `{{steps.MyStep.stdout}}` would silently fail to
 * expand instead of failing loudly.
 */
const TEMPLATE_RE = /\{\{steps\.([a-z0-9_-]+)\.([a-zA-Z]+)\}\}/g;
/** Regex for the legacy `{{prev}}` token. */
const PREV_RE = /\{\{prev\}\}/g;

const MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB per stream

/** Shell interpreters that must not appear as the command binary. */
const BLOCKED_INTERPRETERS = new Set([
  'bash', 'sh', 'dash', 'zsh', 'ksh', 'fish',
  'python', 'python3', 'perl', 'ruby', 'node', 'deno',
  'php', 'lua', 'tclsh', 'awk',
]);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a single WorkflowStep.
 * Throws with a descriptive message on the first violation found.
 */
export function validateStep(step: WorkflowStep): void {
  if (!step.id || !STEP_ID_RE.test(step.id)) {
    throw new Error(`Invalid step id "${step.id}": must match /^[a-z0-9_-]+$/`);
  }
  if (!step.command || typeof step.command !== 'string') {
    throw new Error(`Step "${step.id}": command must be a non-empty string`);
  }
  if (DANGEROUS_RE.test(step.command)) {
    throw new Error(
      `Step "${step.id}": command contains forbidden characters (\`$(\`, backticks, or \`|\`)`,
    );
  }

  // Reject shell interpreters as the command binary. This also runs for
  // `type: 'tool'` steps (where command is a tool name, not a shell command);
  // that is harmless — real tool names are `category.action` and never match an
  // interpreter — and keeps the guard uniform. A non-existent tool name would
  // fail honestly at registry.execute() time, not here.
  const firstToken = step.command.split(/\s+/)[0] ?? '';
  const bin = path.basename(firstToken);
  if (BLOCKED_INTERPRETERS.has(bin)) {
    throw new Error(
      `Step "${step.id}": interpreter commands are not allowed (got "${bin}")`,
    );
  }

  // Validate stdin: allow the literal '{{prev}}' placeholder; reject shell
  // metacharacters otherwise. Tool steps are exempt — their stdin carries JSON
  // args parsed and handed to a host tool (registry.execute), so it never
  // reaches a shell and the injection guard does not apply.
  if (step.type !== 'tool' && step.stdin !== undefined && step.stdin !== '{{prev}}') {
    if (STDIN_DANGEROUS_RE.test(step.stdin)) {
      throw new Error(
        `Step "${step.id}": stdin contains forbidden characters (shell metacharacters are not allowed)`,
      );
    }
  }

  if (step.timeout !== undefined && (typeof step.timeout !== 'number' || step.timeout <= 0)) {
    throw new Error(`Step "${step.id}": timeout must be a positive number`);
  }

  // parallel_group and phase are mutually exclusive: each step picks ONE
  // fan-out scope. Mixing the two would conflate peer-group semantics with
  // barrier-stage semantics and break the unambiguous "what does this step
  // belong to" mental model the scheduler relies on.
  if (step.parallel_group !== undefined && step.phase !== undefined) {
    throw new Error(
      `Step "${step.id}": parallel_group "${step.parallel_group}" and phase "${step.phase}" ` +
        'cannot both be set on the same step — pick one fan-out scope',
    );
  }

  // Members of a fan-out (parallel_group OR phase) may not use {{prev}} —
  // fan-out has no defined intra-member ordering, so "the previous step" is
  // ambiguous. Authors must reference a specific upstream id via
  // {{steps.<id>.<field>}} against a step outside the fan-out. Approval gates
  // are also forbidden for the same reason: their resume token semantics
  // assume a single ordered step, not a settled fan-out.
  const fanOutLabel =
    step.parallel_group !== undefined
      ? { kind: 'parallel_group', value: step.parallel_group }
      : step.phase !== undefined
        ? { kind: 'phase', value: step.phase }
        : null;
  if (fanOutLabel) {
    if (step.command.includes('{{prev}}') || (step.stdin ?? '').includes('{{prev}}')) {
      throw new Error(
        `Step "${step.id}": {{prev}} is forbidden inside ${fanOutLabel.kind} "${fanOutLabel.value}" — ` +
          'use explicit {{steps.<id>.<field>}} against a step outside the fan-out',
      );
    }
    if (step.approval === true) {
      throw new Error(
        `Step "${step.id}": approval gates are not supported inside ${fanOutLabel.kind} "${fanOutLabel.value}"`,
      );
    }
  }
}

/**
 * Validate a Workflow object.
 * Throws on the first structural or security violation.
 */
export function validateWorkflow(wf: Workflow): void {
  if (!wf.name || typeof wf.name !== 'string') {
    throw new Error('Workflow must have a non-empty string "name"');
  }
  if (!Array.isArray(wf.steps) || wf.steps.length === 0) {
    throw new Error(`Workflow "${wf.name}": must have at least one step`);
  }

  const seenIds = new Set<string>();
  for (const step of wf.steps) {
    validateStep(step);
    if (seenIds.has(step.id)) {
      throw new Error(`Workflow "${wf.name}": duplicate step id "${step.id}"`);
    }
    seenIds.add(step.id);
  }
}

// ---------------------------------------------------------------------------
// Condition evaluator (safe — no eval)
// ---------------------------------------------------------------------------

/** Internal map shape used when resolving `steps.<id>.<field>` accessors. */
export type AccessorMap = Record<string, Record<string, StepResult>>;

/**
 * Resolve a `steps.<id>.<field>` accessor.
 * Returns undefined when the step or field does not exist.
 */
function resolveAccessor(token: string, stepsMap: AccessorMap): unknown {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'steps') return undefined;
  const [, stepId, field] = parts as [string, string, string];
  return stepsMap['steps']?.[stepId]?.[field as keyof StepResult];
}

/** Coerce a raw token string to a typed JS value. */
function coerceToken(token: string, stepsMap: AccessorMap): unknown {
  if (token.startsWith('steps.')) return resolveAccessor(token, stepsMap);
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'undefined') return undefined;
  if (token === 'null') return null;
  if (/^-?\d+$/.test(token)) return parseInt(token, 10);
  if (/^-?\d+\.\d+$/.test(token)) return parseFloat(token);
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Evaluate a condition expression against step results.
 *
 * Supported operators: `===`, `!==`, `&&`, `||`.
 * Evaluation is left-to-right. Parentheses are not supported.
 *
 * @param expr      - Condition string, e.g. `"steps.check-disk.exitCode === 0"`.
 * @param stepsMap  - Map `{ steps: { [id]: StepResult } }`.
 * @returns Boolean result of the expression, or `false` on malformed input.
 */
export function evaluateCondition(expr: string, stepsMap: AccessorMap): boolean {
  const tokens = expr.trim().split(/\s+/);

  const results: boolean[] = [];
  const logics: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok === '&&' || tok === '||') {
      logics.push(tok);
      i++;
      continue;
    }

    const lhsToken = tokens[i];
    const op = tokens[i + 1];
    const rhsToken = tokens[i + 2];

    if (op !== '===' && op !== '!==') {
      log.warn({ expr, token: tok }, 'evaluateCondition: unrecognised operator, treating as false');
      return false;
    }

    const lhs = coerceToken(lhsToken ?? '', stepsMap);
    const rhs = coerceToken(rhsToken ?? '', stepsMap);
    results.push(op === '===' ? lhs === rhs : lhs !== rhs);
    i += 3;
  }

  if (results.length === 0) return false;

  let acc = results[0] as boolean;
  for (let j = 0; j < logics.length; j++) {
    const next = results[j + 1] ?? false;
    acc = logics[j] === '&&' ? acc && next : acc || next;
  }

  return acc;
}

// ---------------------------------------------------------------------------
// Template rendering — `{{prev}}` and `{{steps.<id>.<field>}}`
// ---------------------------------------------------------------------------

/**
 * Expand template tokens in `text` against the run's completed-step results.
 *
 * Tokens:
 *   - `{{prev}}` — last sequentially completed step's `stdout` (legacy).
 *     Caller is responsible for forbidding this token inside parallel groups
 *     (validateStep does so at workflow load time).
 *   - `{{steps.<id>.<field>}}` — value of `<field>` on the StepResult keyed by
 *     `<id>`. Allowed fields: stdout, stderr, exitCode, status, durationMs.
 *
 * Returns the rendered text plus a flag set when ANY token expanded — the
 * caller uses this to decide whether to re-validate the rendered string under
 * the shell-metachar guards (untrusted step output may carry `$()` / `|` / `;`).
 */
export function renderTemplate(
  text: string,
  completedSteps: StepResult[],
): { rendered: string; expanded: boolean } {
  if (!text) return { rendered: text, expanded: false };

  const byId: Record<string, StepResult> = {};
  for (const r of completedSteps) byId[r.id] = r;
  const prev = completedSteps[completedSteps.length - 1];

  let expanded = false;
  let out = text;

  out = out.replace(PREV_RE, () => {
    expanded = true;
    return prev?.stdout ?? '';
  });

  out = out.replace(TEMPLATE_RE, (match, id: string, field: string) => {
    const step = byId[id];
    if (!step) return match; // honestly unsubstituted — caller re-validates
    if (!TEMPLATE_FIELDS.has(field as keyof StepResult)) return match;
    const v = step[field as keyof StepResult];
    expanded = true;
    if (v === undefined || v === null) return '';
    return String(v);
  });

  return { rendered: out, expanded };
}

/**
 * Throw if the rendered shell command carries forbidden metacharacters. Used
 * AFTER template substitution: a step output is untrusted, so `$()` / backtick
 * / pipe in the rendered command must halt the run honestly rather than feed
 * an attacker-controlled value into spawn() — even though spawn has shell:false,
 * pipes would still split argv and `$()` would land as a literal arg by luck
 * rather than design.
 */
export function assertRenderedCommandSafe(stepId: string, command: string): void {
  if (DANGEROUS_RE.test(command)) {
    throw new Error(
      `Step "${stepId}": rendered command contains forbidden characters ` +
        '(template expansion injected `$(`, backtick, or `|`)',
    );
  }
}

// Rendered shell stdin is intentionally NOT re-validated: stdin is a pipe to
// the child process (spawn with shell:false), not a shell expression, so bytes
// from a prior step's stdout (newlines, `;`, `$()`, etc.) can flow through
// without injection risk. The load-time STDIN_DANGEROUS_RE check still rejects
// shell metacharacters in *literal* stdin authored in the YAML, where they
// likely signal a user error rather than legitimate piped data.

// ---------------------------------------------------------------------------
// Shell execution
// ---------------------------------------------------------------------------

/**
 * Execute a shell command using child_process.spawn with an argv array.
 * Never uses `shell: true`.
 *
 * @param command   - Space-separated command string.
 * @param stdinData - Optional string written to the process stdin.
 * @param timeoutMs - Optional kill timeout in milliseconds.
 * @returns stdout, stderr, and the numeric exit code.
 */
export async function execShell(
  command: string,
  stdinData?: string,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command.split(/\s+/).filter(Boolean);
    if (!cmd) {
      resolve({ stdout: '', stderr: 'Empty command', exitCode: 1 });
      return;
    }

    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let truncated = false;
    let stdoutLen = 0;
    let stderrLen = 0;

    // Timer for SIGTERM timeout; killTimer is the SIGKILL escalation
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        log.warn({ cmd, timeoutMs }, 'Step timed out — sending SIGTERM');
        // Escalate to SIGKILL after 5 seconds if the process has not exited
        killTimer = setTimeout(() => {
          log.warn({ cmd }, 'Step still alive after SIGTERM — sending SIGKILL');
          child.kill('SIGKILL');
        }, 5000);
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      stdoutLen += chunk.length;
      if (stdoutLen > MAX_OUTPUT) {
        truncated = true;
        child.kill('SIGTERM');
        log.warn({ cmd }, 'stdout exceeded MAX_OUTPUT — process killed');
        return;
      }
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      stderrLen += chunk.length;
      if (stderrLen > MAX_OUTPUT) {
        truncated = true;
        child.kill('SIGTERM');
        log.warn({ cmd }, 'stderr exceeded MAX_OUTPUT — process killed');
        return;
      }
      stderr += chunk.toString();
    });

    if (stdinData !== undefined) {
      child.stdin?.write(stdinData);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (truncated) {
        stderr += '\n[stream truncated at 10MB]';
      }
      resolve({
        stdout,
        stderr,
        exitCode: (killed || truncated) ? 124 : (code ?? 1),
      });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout: '', stderr: String(err), exitCode: 1 });
    });
  });
}
