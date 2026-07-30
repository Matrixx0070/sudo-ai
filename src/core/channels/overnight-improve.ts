/**
 * @file overnight-improve.ts
 * @description TX19 v1 — overnight self-improvement with a one-tap Deploy
 * card. Nightly (SUDO_TX19_OVERNIGHT=1, hour via SUDO_TX19_HOUR_UTC, default
 * 03:00 UTC) the runner executes ONE bounded self-improvement cycle through
 * the injected engine (prod wires runSelfImprovement WITH a real HeldOutGate
 * — an absent gate fail-closes since #988), renders the outcome as a deploy
 * card, and files a TX10 checkpoint (Deploy / Skip).
 *
 * FRANK GATE ABSOLUTE (AL8.6 auto-merge=NO): "Deploy" NEVER auto-applies
 * anything here. The tap produces a persisted decision artifact that marks
 * the run approved-for-apply; applying remains a human/operator action. Skip
 * and HOLD leave the run parked. Invariant 10: one run per night, engine
 * budget rides the engine's own gates; this module makes NO llm calls
 * itself.
 */

import { createLogger } from '../shared/logger.js';
import { getCheckpointProtocol } from './checkpoint-registry.js';
import { CHECKPOINT_HOLD } from './checkpoint-protocol.js';

const log = createLogger('channels:tx19');

export function overnightImproveEnabled(): boolean {
  return process.env['SUDO_TX19_OVERNIGHT'] === '1';
}

export function overnightHourUtc(): number {
  const raw = Number(process.env['SUDO_TX19_HOUR_UTC']);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 3;
}

export interface ImprovementRunSummary {
  healthScore: number;
  summary: string;
  actions: Array<{ type: string; description: string; applied: boolean }>;
}

/** Engine seam — prod wires runSelfImprovement (with its HeldOutGate). */
export type ImprovementEngine = () => Promise<ImprovementRunSummary>;

/** Render the deploy card body from a run summary. Pure. */
export function renderDeployCard(run: ImprovementRunSummary, date: string): string {
  const applied = run.actions.filter((a) => a.applied);
  const held = run.actions.filter((a) => !a.applied);
  const lines: string[] = [
    `🌙 Overnight self-improvement — ${date}`,
    `Health score: ${run.healthScore}`,
    '',
  ];
  if (applied.length > 0) {
    lines.push(`Gate-passed (${applied.length}):`);
    for (const a of applied.slice(0, 6)) lines.push(`  ✓ [${a.type}] ${a.description}`);
  }
  if (held.length > 0) {
    lines.push(`Held by gate (${held.length}):`);
    for (const a of held.slice(0, 6)) lines.push(`  ◦ [${a.type}] ${a.description}`);
  }
  if (run.actions.length === 0) lines.push('No proposals this cycle.');
  lines.push('', 'Deploy = mark approved-for-apply (applying stays manual). Skip = park.');
  return lines.join('\n');
}

export interface OvernightRunResult {
  ran: boolean;
  decision?: string;
  reason?: string;
}

/**
 * One overnight cycle: run the engine, file the deploy-card checkpoint,
 * return the decision. Engine failure files NO checkpoint (nothing to
 * deploy); a missing checkpoint protocol HOLDs (invariant 8).
 */
export async function runOvernightCycle(engine: ImprovementEngine, date: string, timeoutMs?: number): Promise<OvernightRunResult> {
  let run: ImprovementRunSummary;
  try {
    run = await engine();
  } catch (err) {
    log.warn({ err: String(err) }, 'TX19: engine run failed — no deploy card filed');
    return { ran: false, reason: `engine failed: ${String(err)}` };
  }

  const proto = getCheckpointProtocol();
  if (!proto) {
    log.warn('TX19: no checkpoint protocol — run summary parked, HOLD');
    return { ran: true, decision: CHECKPOINT_HOLD, reason: 'no checkpoint protocol wired' };
  }

  const decision = await proto.request({
    kind: 'tx19:deploy',
    question: renderDeployCard(run, date),
    options: ['Deploy', 'Skip'],
    context: { date, healthScore: run.healthScore, actionCount: run.actions.length },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  log.info({ date, decision: decision.decision, decided: decision.decided }, 'TX19: overnight cycle decided');
  // "Deploy" = the persisted checkpoint row IS the approval artifact; nothing
  // auto-applies (AL8.6). Skip/HOLD leave the run parked for review.
  return { ran: true, decision: decision.decision };
}
