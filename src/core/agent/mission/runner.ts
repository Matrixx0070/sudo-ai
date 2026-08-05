/**
 * @file agent/mission/runner.ts
 * @description Advance a mission by exactly ONE step, in whatever session is
 * running — chat, cron, or a process started tomorrow.
 *
 * This is the piece that makes work cross a session boundary. The heartbeat
 * cron runs in its own session and cannot see the chat where a goal was given;
 * the mission record on disk is the shared ground, and this module is what
 * turns that record into a prompt, runs one step, verifies it, and writes the
 * result back.
 *
 * The contract that keeps it honest:
 *   1. The step's `doneWhen` is checked by a SEPARATE verification call that is
 *      shown the work and told to answer DONE / NOT_DONE / BLOCKED. The cursor
 *      moves only on DONE. The executing turn does not get to grade itself on
 *      the question "did I finish".
 *   2. BLOCKED (needs money / credentials / an owner decision) parks the
 *      mission with a typed blocker instead of retrying forever.
 *   3. Repeated NOT_DONE on the same step escalates: retry, then a blocker.
 *      No infinite grinding on an impossible step.
 */

import { createLogger } from '../../shared/logger.js';
import type { Mission, MissionStep } from './types.js';
import { nextStep, progressLine } from './types.js';
import { saveMission, recordHistory, addBlocker, setPlan } from './store.js';
import { planMission, type PlannerBrain } from './planner.js';

const log = createLogger('agent:mission:runner');

/** Attempts on one step before it becomes an owner-facing blocker. */
const MAX_STEP_ATTEMPTS = 3;
/** Consecutive failed advances before the whole mission is marked failed. */
const MAX_MISSION_FAILURES = 6;

/** How the runner reaches the agent. Injected so this module stays testable. */
export interface MissionExecutor {
  /** Run one turn with `prompt`; resolves with the agent's final text. */
  run(prompt: string, opts: { missionId: string; stepId: string }): Promise<string>;
  /** Estimated USD the last run cost (0 when unknown). */
  lastRunCostUsd?(): number;
}

export interface AdvanceDeps {
  executor: MissionExecutor;
  brain: PlannerBrain;
  /** Notify the owner (blocker raised, mission finished). Best-effort. */
  notify?: (mission: Mission, message: string) => void | Promise<void>;
}

export type AdvanceOutcome =
  | { kind: 'planned'; steps: number }
  | { kind: 'advanced'; step: MissionStep }
  | { kind: 'retry'; step: MissionStep; reason: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'completed' }
  | { kind: 'idle'; reason: string };

const VERDICT_PROMPT = `You are verifying whether one step of a long-running mission is genuinely finished.

You will be given the step, its completion criterion, and what the agent reported doing. Inspect the actual system (files, git, commands) to check the criterion — do not take the report at face value.

Reply with EXACTLY ONE line, then nothing else:
DONE: <one-line evidence you personally checked>
NOT_DONE: <what is still missing>
BLOCKED|<owner_decision|credential|money|external>: <what the owner must supply>`;

/** Parse the verifier's single-line verdict. Unrecognised text = NOT_DONE. */
export function parseVerdict(raw: string):
  | { kind: 'done'; evidence: string }
  | { kind: 'not_done'; missing: string }
  | { kind: 'blocked'; blockerKind: 'owner_decision' | 'credential' | 'money' | 'external'; detail: string } {
  const text = (raw ?? '').trim();
  const blocked = /^BLOCKED\|(owner_decision|credential|money|external)\s*:\s*(.+)$/im.exec(text);
  if (blocked) {
    return {
      kind: 'blocked',
      blockerKind: blocked[1] as 'owner_decision' | 'credential' | 'money' | 'external',
      detail: blocked[2]!.trim().slice(0, 400),
    };
  }
  const done = /^DONE\s*:\s*(.+)$/im.exec(text);
  if (done) return { kind: 'done', evidence: done[1]!.trim().slice(0, 300) };
  const notDone = /^NOT_DONE\s*:\s*(.+)$/im.exec(text);
  if (notDone) return { kind: 'not_done', missing: notDone[1]!.trim().slice(0, 300) };
  // Unrecognised → treat as NOT done. Never advance on an unparseable verdict.
  return { kind: 'not_done', missing: `unparseable verdict: ${text.slice(0, 120)}` };
}

/** Build the prompt that carries the whole mission across the session boundary. */
export function buildStepPrompt(m: Mission, step: MissionStep): string {
  const done = m.steps.filter((s) => s.status === 'done');
  const lines = [
    `[MISSION ${m.id} — autonomous continuation, no user is watching this turn]`,
    `GOAL: ${m.goal}`,
    `Progress: ${progressLine(m)}`,
    '',
  ];
  if (done.length > 0) {
    lines.push('Already completed (do NOT redo):');
    for (const s of done.slice(-8)) lines.push(`- ${s.description}${s.note ? ` → ${s.note}` : ''}`);
    lines.push('');
  }
  if (m.artifacts.length > 0) {
    lines.push(`Artifacts so far: ${m.artifacts.slice(-12).join(', ')}`, '');
  }
  lines.push(
    `YOUR STEP NOW: ${step.description}`,
    `THIS STEP IS DONE WHEN: ${step.doneWhen}`,
    '',
    'Do this step only — not the whole mission. Work concretely and leave real',
    'artifacts (files, commits, PRs) behind; a later verification pass will check',
    'the criterion against the actual system, so a report without work will fail.',
    'If you cannot proceed without the owner (money, credentials, a decision),',
    'say so plainly and stop rather than guessing.',
  );
  if (step.attempts > 0) {
    lines.push('', `NOTE: this is attempt ${step.attempts + 1}. A previous attempt did not satisfy the criterion — try a different approach.`);
  }
  return lines.join('\n');
}

/** Build the verification prompt for a completed attempt. */
export function buildVerifyPrompt(step: MissionStep, report: string): string {
  return [
    VERDICT_PROMPT,
    '',
    `STEP: ${step.description}`,
    `CRITERION: ${step.doneWhen}`,
    '',
    'AGENT REPORT:',
    report.slice(0, 4000),
  ].join('\n');
}

/**
 * Advance `m` by one step. Persists every outcome. Never throws — a mission
 * must survive a bad run, and the scheduler that calls this must never die.
 */
export async function advanceMission(m: Mission, deps: AdvanceDeps): Promise<AdvanceOutcome> {
  try {
    // Phase 1 — plan, if this is a fresh mission.
    if (m.status === 'planning' || m.steps.length === 0) {
      const steps = await planMission(deps.brain, m.goal);
      setPlan(m, steps);
      saveMission(m);
      void deps.notify?.(m, `Mission planned: ${steps.length} steps.\n${steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n')}`);
      return { kind: 'planned', steps: steps.length };
    }

    // Phase 2 — is there anything left?
    const step = nextStep(m);
    if (!step) {
      m.status = 'completed';
      recordHistory(m, 'all steps complete');
      saveMission(m);
      void deps.notify?.(m, `Mission COMPLETE — ${m.goal}\n${progressLine(m)}\nArtifacts: ${m.artifacts.slice(-15).join(', ') || '(none recorded)'}`);
      return { kind: 'completed' };
    }

    // Phase 3 — execute one step.
    step.status = 'in_progress';
    step.startedAt ??= new Date().toISOString();
    step.attempts += 1;
    m.lastRunAt = new Date().toISOString();
    saveMission(m);

    const report = await deps.executor.run(buildStepPrompt(m, step), { missionId: m.id, stepId: step.id });
    m.spendUsd += deps.executor.lastRunCostUsd?.() ?? 0;

    // Phase 4 — verify against the criterion (independent of the executing turn).
    const verdictText = await deps.executor.run(buildVerifyPrompt(step, report), { missionId: m.id, stepId: step.id });
    m.spendUsd += deps.executor.lastRunCostUsd?.() ?? 0;
    const verdict = parseVerdict(verdictText);

    if (verdict.kind === 'blocked') {
      step.status = 'pending';
      addBlocker(m, { kind: verdict.blockerKind, detail: verdict.detail });
      m.consecutiveFailures = 0; // a blocker is not a failure — it is a question
      saveMission(m);
      void deps.notify?.(m, `Mission BLOCKED — needs you (${verdict.blockerKind}):\n${verdict.detail}\n\nGoal: ${m.goal}\n${progressLine(m)}`);
      return { kind: 'blocked', reason: verdict.detail };
    }

    if (verdict.kind === 'done') {
      step.status = 'done';
      step.note = verdict.evidence;
      step.finishedAt = new Date().toISOString();
      m.cursor += 1;
      m.consecutiveFailures = 0;
      recordHistory(m, `step done: ${step.description.slice(0, 80)} — ${verdict.evidence.slice(0, 80)}`);
      saveMission(m);
      return { kind: 'advanced', step };
    }

    // NOT_DONE — retry, or escalate to the owner after MAX_STEP_ATTEMPTS.
    step.status = 'pending';
    step.note = verdict.missing;
    m.consecutiveFailures += 1;
    recordHistory(m, `step not done (attempt ${step.attempts}): ${verdict.missing.slice(0, 100)}`);

    if (step.attempts >= MAX_STEP_ATTEMPTS) {
      addBlocker(m, {
        kind: 'error',
        detail: `Step "${step.description.slice(0, 120)}" failed ${step.attempts} attempts. Last gap: ${verdict.missing}`,
      });
      saveMission(m);
      void deps.notify?.(m, `Mission STUCK on a step after ${step.attempts} attempts:\n${step.description}\nMissing: ${verdict.missing}\n\nGoal: ${m.goal}`);
      return { kind: 'blocked', reason: verdict.missing };
    }

    if (m.consecutiveFailures >= MAX_MISSION_FAILURES) {
      m.status = 'failed';
      recordHistory(m, `mission failed after ${m.consecutiveFailures} consecutive failed advances`);
      saveMission(m);
      void deps.notify?.(m, `Mission FAILED after ${m.consecutiveFailures} consecutive failed advances.\nGoal: ${m.goal}`);
      return { kind: 'blocked', reason: 'too many consecutive failures' };
    }

    saveMission(m);
    return { kind: 'retry', step, reason: verdict.missing };
  } catch (err) {
    // A crashed advance must not kill the mission or the scheduler.
    m.consecutiveFailures += 1;
    recordHistory(m, `advance threw: ${String(err).slice(0, 200)}`);
    if (m.consecutiveFailures >= MAX_MISSION_FAILURES) m.status = 'failed';
    try { saveMission(m); } catch { /* disk problem — already logged below */ }
    log.warn({ missionId: m.id, err: String(err) }, 'Mission advance threw — recorded, mission preserved');
    return { kind: 'idle', reason: String(err).slice(0, 200) };
  }
}
