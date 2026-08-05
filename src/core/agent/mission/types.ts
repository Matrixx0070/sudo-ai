/**
 * @file agent/mission/types.ts
 * @description The durable shape of a multi-day goal.
 *
 * WHY THIS EXISTS (2026-08-05): everything the agent needs to survive an
 * INTERRUPTION now exists (run journal, honest stop reasons, budget
 * visibility). None of it lets work survive across DAYS, because a goal only
 * ever lived in a chat transcript: the sole autonomous trigger (the heartbeat
 * cron) runs in its own session and is explicitly scoped to a fixed checklist,
 * so it can neither see nor act on a goal you gave in Telegram.
 *
 * A Mission is the missing durable object: the goal, a verifiable plan, a
 * cursor into that plan, the artifacts produced so far, what it is blocked on,
 * and what it has spent. It lives on disk, so ANY session — chat, cron, a
 * process started tomorrow — can pick it up and continue.
 *
 * Design rules:
 *   - Every step carries a `doneWhen` criterion. The cursor only advances when
 *     that criterion is verified, so a mission can never report fake progress.
 *   - Blockers are first-class and typed: work that needs the owner (money,
 *     credentials, a decision) PARKS the mission and asks, instead of looping.
 *   - Spend and deadline are tracked per MISSION, not per run — a 3-day goal is
 *     many runs, and per-run limits say nothing about the total.
 */

/** Lifecycle of a mission. Terminal states: completed | failed | cancelled. */
export type MissionStatus =
  | 'planning'   // goal accepted, plan not yet built
  | 'active'     // has a plan, advancing
  | 'blocked'    // needs the owner (see blockers[]) — will not self-advance
  | 'paused'     // owner paused it
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Status of one step within a mission's plan. */
export type MissionStepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

/** One unit of work with an explicit, checkable completion criterion. */
export interface MissionStep {
  id: string;
  /** What to do, phrased as an instruction to the agent. */
  description: string;
  /**
   * How to know it is finished — a criterion the verifier can check
   * (a file exists, a command exits 0, a PR is merged). Never "looks good".
   */
  doneWhen: string;
  status: MissionStepStatus;
  /** Advance attempts spent on this step (drives give-up / escalation). */
  attempts: number;
  /** Paths or URLs this step produced. */
  artifacts: string[];
  /** One-line outcome recorded when the step settles. */
  note?: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Something that stops the mission and (usually) needs the owner. */
export interface MissionBlocker {
  at: string;
  kind: 'owner_decision' | 'credential' | 'money' | 'external' | 'error';
  detail: string;
  /** Set when the owner clears it; a resolved blocker no longer parks the run. */
  resolved?: boolean;
}

/** A durable multi-run, multi-day goal. */
export interface Mission {
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  status: MissionStatus;
  /** The plan. Empty while status === 'planning'. */
  steps: MissionStep[];
  /** Index of the next step to run. Advances ONLY after verification. */
  cursor: number;
  /** Everything produced across all steps (deduped). */
  artifacts: string[];
  blockers: MissionBlocker[];
  /** Total estimated USD across every advance run. */
  spendUsd: number;
  /** Mission-wide ceiling; null = no ceiling (owner decides). */
  maxSpendUsd: number | null;
  /** ISO date the mission should be done by; null = open-ended. */
  deadline: string | null;
  /** Where to report progress (channel adapter + peer). */
  originChannel?: string;
  originPeerId?: string;
  lastRunAt?: string;
  /** Consecutive FAILED advances — the give-up guard. */
  consecutiveFailures: number;
  /** Free-form log of what each advance did, newest last. */
  history: Array<{ at: string; event: string }>;
}

/** A mission that will self-advance on the next scheduler tick. */
export function isAdvanceable(m: Mission): boolean {
  if (m.status !== 'active' && m.status !== 'planning') return false;
  if (m.blockers.some((b) => !b.resolved)) return false;
  if (m.maxSpendUsd !== null && m.spendUsd >= m.maxSpendUsd) return false;
  if (m.deadline !== null && new Date(m.deadline).getTime() < Date.now()) return false;
  return true;
}

/** Why a mission is not advanceable — for status output and owner reports. */
export function stallReason(m: Mission): string | null {
  if (isAdvanceable(m)) return null;
  const open = m.blockers.filter((b) => !b.resolved);
  if (open.length > 0) return `blocked: ${open.map((b) => `${b.kind} — ${b.detail}`).join('; ')}`;
  if (m.maxSpendUsd !== null && m.spendUsd >= m.maxSpendUsd) {
    return `mission budget reached ($${m.spendUsd.toFixed(2)} of $${m.maxSpendUsd.toFixed(2)})`;
  }
  if (m.deadline !== null && new Date(m.deadline).getTime() < Date.now()) {
    return `deadline passed (${m.deadline})`;
  }
  return `status is ${m.status}`;
}

/** The next pending step, or null when the plan is exhausted. */
export function nextStep(m: Mission): MissionStep | null {
  return m.steps[m.cursor] ?? null;
}

/** Compact progress line: "3/8 steps · $2.10 · 1 blocker". */
export function progressLine(m: Mission): string {
  const done = m.steps.filter((s) => s.status === 'done').length;
  const parts = [`${done}/${m.steps.length} steps`, `$${m.spendUsd.toFixed(2)}`];
  const open = m.blockers.filter((b) => !b.resolved).length;
  if (open > 0) parts.push(`${open} blocker${open === 1 ? '' : 's'}`);
  if (m.deadline) parts.push(`due ${m.deadline.slice(0, 10)}`);
  return parts.join(' · ');
}
