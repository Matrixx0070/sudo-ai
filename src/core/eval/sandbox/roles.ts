/**
 * @file roles.ts
 * @description Multi-agent role sequencing for eval-sandbox runs (ADR-0007
 * Phase 4). KEPT DELIBERATELY SIMPLE: roles run SEQUENTIALLY in manifest order
 * inside the ONE existing sandboxed child process — one session per role in the
 * run-local SessionManager, each as an untrusted turn. No new messaging
 * plumbing: inter-role state is the previous role's final text, passed via the
 * {previous} placeholder (8KB cap). sessions.send is NOT wired in the eval
 * child (its meta-tool deps are never injected by the eval bootstrap and it is
 * owner-tier only, while every eval turn is untrusted) — so there is nothing to
 * "leave available"; roles communicate through {previous} and the shared
 * workspace.
 *
 * Lives outside eval-turn-entry.ts because that file executes main() on import;
 * this module is the testable seam (runRoleTurns + injected RoleTurnRunner).
 */

import type { RunJournal } from './run-journal.js';
import type { ScenarioRole } from './scenario.js';

/** Cap on the {previous} substitution payload. */
export const PREVIOUS_TEXT_CAP_BYTES = 8 * 1024;

export interface RoleTurnOutcome {
  text: string;
  steps: number;
  error?: string;
}

/**
 * Runs ONE agent turn for a role. The child injects the real AgentLoop here;
 * tests inject a stub — role sequencing is then testable without LLM calls.
 */
export type RoleTurnRunner = (args: {
  role: ScenarioRole;
  /** Stable per-role session key inside the run-local SessionManager. */
  sessionKey: string;
  message: string;
  maxIterations: number;
}) => Promise<RoleTurnOutcome>;

export interface RunRoleTurnsArgs {
  roles: ScenarioRole[];
  runId: string;
  workspaceDir: string;
  /** Whole-run step budget; divided ceil(maxSteps/roles.length) per role. */
  maxSteps: number;
  journal: Pick<RunJournal, 'append'>;
  runTurn: RoleTurnRunner;
}

export interface RunRoleTurnsResult {
  /** Last role's final text. */
  text: string;
  /** Sum of steps across all role turns. */
  steps: number;
  error?: string;
}

/** Per-role iteration cap: whole-run maxSteps divided evenly across roles. */
export function perRoleMaxIterations(maxSteps: number, roleCount: number): number {
  return Math.max(1, Math.ceil(maxSteps / Math.max(1, roleCount)));
}

/** Build a role's turn message: persona preamble + prompt with placeholders. */
export function buildRoleMessage(
  role: ScenarioRole,
  workspaceDir: string,
  previousText: string,
): string {
  const previous = previousText.length > PREVIOUS_TEXT_CAP_BYTES
    ? previousText.slice(0, PREVIOUS_TEXT_CAP_BYTES)
    : previousText;
  const prompt = role.prompt
    .replace(/\{workspace\}/g, workspaceDir)
    .replace(/\{previous\}/g, previous);
  return role.persona !== undefined
    ? `[You are the "${role.name}" role. ${role.persona}]\n\n${prompt}`
    : prompt;
}

/**
 * Execute the role turns sequentially. Journals a `role.turn` event per role
 * {role, steps, ok}; stops the sequence on the first errored turn (the run
 * grades as failed anyway — eval-runner forces success=false on turn error).
 */
export async function runRoleTurns(args: RunRoleTurnsArgs): Promise<RunRoleTurnsResult> {
  const maxIterations = perRoleMaxIterations(args.maxSteps, args.roles.length);
  let previousText = '';
  let totalSteps = 0;
  for (const role of args.roles) {
    const message = buildRoleMessage(role, args.workspaceDir, previousText);
    let outcome: RoleTurnOutcome;
    try {
      outcome = await args.runTurn({
        role,
        sessionKey: `eval-${args.runId}-${role.name}`,
        message,
        maxIterations,
      });
    } catch (err) {
      outcome = { text: '', steps: 0, error: String(err).slice(0, 500) };
    }
    totalSteps += outcome.steps;
    args.journal.append({
      type: 'role.turn',
      role: role.name,
      steps: outcome.steps,
      ok: outcome.error === undefined,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
    if (outcome.error !== undefined) {
      return { text: outcome.text, steps: totalSteps, error: `role '${role.name}' failed: ${outcome.error}` };
    }
    previousText = outcome.text;
  }
  return { text: previousText, steps: totalSteps };
}
