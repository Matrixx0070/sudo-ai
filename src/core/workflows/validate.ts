/**
 * @file workflows/validate.ts
 * @description Load-time validation for the Lobster workflow engine — step
 * schema, security guards (interpreter/metachar rejection), fan-out rules,
 * retry policy (AL2.3), and static condition checking (fail-loud rule: a
 * typo'd condition throws at load time instead of silently skipping its step
 * at runtime). Split from executor.ts under the max-lines ratchet.
 */

import path from 'node:path';
import type { Workflow, WorkflowStep } from './types.js';

const STEP_ID_RE = /^[a-z0-9_-]+$/;
/** Exported: executor re-checks rendered commands against this after template expansion. */
export const DANGEROUS_RE = /\$\(|`|\|/;
// Extended check: also blocks shell metacharacters when validating stdin
const STDIN_DANGEROUS_RE = /\$\(|`|\||;|&|>|<|\n/;
/** Upper bound on per-step retry attempts (AL2.3) — keeps retries bounded by construction. */
export const MAX_RETRY_ATTEMPTS = 10;

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

  // Retry policy (AL2.3): bounded, integer attempts; non-negative backoff.
  // Approval gates cannot retry — a denied/timed-out gate is a decision, not
  // a transient failure.
  if (step.retry !== undefined) {
    const { max_attempts, backoff_ms } = step.retry;
    if (!Number.isInteger(max_attempts) || max_attempts < 1 || max_attempts > MAX_RETRY_ATTEMPTS) {
      throw new Error(
        `Step "${step.id}": retry.max_attempts must be an integer 1..${MAX_RETRY_ATTEMPTS} (got ${max_attempts})`,
      );
    }
    if (backoff_ms !== undefined && (typeof backoff_ms !== 'number' || !Number.isFinite(backoff_ms) || backoff_ms < 0)) {
      throw new Error(`Step "${step.id}": retry.backoff_ms must be a non-negative number`);
    }
    if (step.approval === true) {
      throw new Error(`Step "${step.id}": retry is forbidden on approval gates`);
    }
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
    // Conditions may only reference PRIOR steps — validated before adding this
    // step's own id, which also rejects self-references and forward references.
    if (step.condition !== undefined) {
      try {
        validateCondition(step.condition, seenIds);
      } catch (err) {
        throw new Error(
          `Workflow "${wf.name}", step "${step.id}": invalid condition — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    seenIds.add(step.id);
  }
}

/**
 * Statically validate a condition expression (AL2.3 fail-loud rule). A typo'd
 * condition previously warn+skipped its step at runtime — silently disabling
 * work. Structural errors (bad operator/arity) and `steps.<id>.*` references
 * to unknown or later steps now throw at load time. Bare-word and quoted
 * literals stay legal (back-compat with the runtime coercion semantics).
 */
export function validateCondition(expr: string, priorStepIds: ReadonlySet<string>): void {
  const tokens = expr.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new Error('condition is empty');
  }

  const checkAtom = (token: string): void => {
    if (!token.startsWith('steps.')) return; // literal — legal by back-compat
    const m = /^steps\.([a-z0-9_-]+)\.[a-zA-Z]+$/.exec(token);
    if (!m) {
      throw new Error(`malformed step reference "${token}" (expected steps.<id>.<field>)`);
    }
    if (!priorStepIds.has(m[1]!)) {
      throw new Error(`unknown step "${m[1]}" in "${token}" — conditions may only reference prior steps`);
    }
  };

  let i = 0;
  let comparisons = 0;
  while (i < tokens.length) {
    if (tokens[i] === '&&' || tokens[i] === '||') {
      i++;
      continue;
    }
    const [lhs, op, rhs] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (op !== '===' && op !== '!==') {
      throw new Error(`unrecognised operator "${op ?? '<missing>'}" after "${lhs}" (supported: === and !==)`);
    }
    if (rhs === undefined) {
      throw new Error(`missing right-hand side after "${lhs} ${op}"`);
    }
    checkAtom(lhs!);
    checkAtom(rhs);
    comparisons++;
    i += 3;
  }
  if (comparisons === 0) {
    throw new Error('condition contains no comparison');
  }
}
