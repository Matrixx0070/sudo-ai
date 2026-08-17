/**
 * @file core/executor.ts
 * @description ActionExecutor — the perception→reasoning→action→verification→
 * recovery closed loop for one subgoal.
 *
 * For each action: capture(before) → ground → authority gate → inject →
 * capture(after) → check expectation. On a failed expectation or failed
 * grounding it walks the recovery ladder:
 *   reground → zoom-reground → replan(hook) → restart-subgoal → escalate.
 *
 * Every step is journaled. The executor speaks the platform-independent core
 * types and drives input through an injected {@link InputSink} (the IComputerUse
 * driver in production, a fake in tests) — so it is fully unit-testable without
 * a display.
 */

import { createLogger } from '../../../../shared/logger.js';
import { authorize } from '../../../../security/execution-authority.js';
import type {
  Action,
  ActionPlan,
  Expectation,
  Grounded,
  PlanResult,
  RecoveryRung,
  Snapshot,
  StepResult,
  Verdict,
} from './types.js';
import { GroundingResolver } from './grounding.js';
import { PerceptionService } from './perception.js';
import { ActionJournal } from './journal.js';

const log = createLogger('computer:executor');

/** The minimal input surface the executor needs — satisfied by IComputerUse. */
export interface InputSink {
  click(x: number, y: number): Promise<{ success: boolean; error?: string }>;
  doubleClick?(x: number, y: number): Promise<{ success: boolean; error?: string }>;
  move?(x: number, y: number): Promise<{ success: boolean; error?: string }>;
  type(text: string): Promise<{ success: boolean; error?: string }>;
  key(key: string): Promise<{ success: boolean; error?: string }>;
  scroll(direction: 'up' | 'down'): Promise<{ success: boolean; error?: string }>;
  focusWindow?(title: string): Promise<{ success: boolean; error?: string }>;
}

export interface ExecutorOptions {
  sessionId: string;
  display: string;
  perception: PerceptionService;
  grounding: GroundingResolver;
  sink: InputSink;
  ownerVerified: boolean;
  journal?: ActionJournal;
  /** Max recovery attempts per action before giving up. Default 4. */
  maxRecoveries?: number;
  /** Optional replanner: given the failing action + snapshot, return a revised action. */
  replan?: (action: Action, snapshot: Snapshot) => Promise<Action | null>;
  /** Called when the ladder is exhausted; lets a mission escalate/hand off. */
  onEscalate?: (action: Action, snapshot: Snapshot, message: string) => Promise<void>;
  /** Settle time (ms) to let the UI react before the post-snapshot. Default 350. */
  settleMs?: number;
  /**
   * Structured-action hook (API-first): given a grounded AX element, try to
   * perform the action via its accessibility action / focus instead of a pixel
   * click. Returns true if it handled the action. Used for click/double_click
   * when grounding resolved a real element. Falls back to the pixel sink on false.
   */
  structuredActor?: (grounded: Grounded, action: Action) => Promise<boolean>;
}

export class ActionExecutor {
  private readonly maxRecoveries: number;
  private readonly settleMs: number;

  constructor(private readonly o: ExecutorOptions) {
    this.maxRecoveries = o.maxRecoveries ?? 4;
    this.settleMs = o.settleMs ?? 350;
  }

  /**
   * Execute a single action (with the full recovery ladder). Public so a
   * resumable runner can drive a plan one step at a time, persisting between
   * steps for restart survival.
   */
  step(subgoal: string, action: Action): Promise<StepResult> {
    return this.runAction(subgoal, action);
  }

  /** Run a whole plan; stops at the first action that fails after recovery. */
  async run(plan: ActionPlan): Promise<PlanResult> {
    const steps: StepResult[] = [];
    for (const action of plan.actions) {
      const step = await this.runAction(plan.subgoal, action);
      steps.push(step);
      if (step.verdict !== 'ok') {
        return { subgoal: plan.subgoal, success: false, steps, reason: step.message };
      }
    }
    return { subgoal: plan.subgoal, success: true, steps };
  }

  private async runAction(subgoal: string, action: Action): Promise<StepResult> {
    const start = Date.now();
    const recovery: RecoveryRung[] = [];
    const before = await this.o.perception.capture(this.o.display);

    let current = action;
    let attempt = 0;
    // Recovery ladder: attempt 0 is the primary try; 1..N escalate.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.attempt(current, before, recovery.length > 0);
      if (res.verdict === 'ok') {
        const step = this.mk(action, res.verdict, res.grounded, recovery, before.seq, res.afterSeq, start, res.message, res.structured);
        await this.journal(subgoal, step, before.hash, res.afterHash);
        return step;
      }

      // Ladder step selection.
      if (attempt >= this.maxRecoveries) {
        const msg = `exhausted recovery after ${attempt} attempts: ${res.message}`;
        recovery.push('escalate');
        if (this.o.onEscalate) {
          try {
            await this.o.onEscalate(current, before, msg);
          } catch (e) {
            log.warn({ err: String(e) }, 'onEscalate threw');
          }
        }
        const step = this.mk(action, res.verdict, res.grounded, recovery, before.seq, res.afterSeq, start, msg, res.structured);
        await this.journal(subgoal, step, before.hash, res.afterHash);
        return step;
      }

      const rung = this.nextRung(attempt, res.verdict);
      recovery.push(rung);
      attempt++;

      if (rung === 'replan' && this.o.replan) {
        const revised = await this.o.replan(current, before).catch(() => null);
        if (revised) current = revised;
      }
      // reground / zoom-reground / restart-subgoal all simply re-capture and
      // re-attempt; zoom-reground additionally hints the grounder (Phase 3
      // wires the vision zoom). Re-capture so we see the latest state.
    }
  }

  private nextRung(attempt: number, verdict: Verdict): RecoveryRung {
    if (verdict === 'grounding-failed') {
      // For grounding failures, zoom before giving up.
      return attempt === 0 ? 'reground' : attempt === 1 ? 'zoom-reground' : 'replan';
    }
    // expectation-failed / error path.
    return attempt === 0 ? 'reground' : attempt === 1 ? 'replan' : 'restart-subgoal';
  }

  /** One attempt of an action against a fresh perception. */
  private async attempt(
    action: Action,
    beforeInitial: Snapshot,
    isRetry: boolean,
  ): Promise<{ verdict: Verdict; grounded?: Grounded; structured?: boolean; afterSeq: number; afterHash?: string; message: string }> {
    // On a retry, re-perceive so grounding uses the latest state.
    const before = isRetry ? await this.o.perception.capture(this.o.display) : beforeInitial;

    // Non-pointer actions.
    if (action.kind === 'wait') {
      await new Promise((r) => setTimeout(r, action.ms ?? 250));
      const after = await this.o.perception.capture(this.o.display);
      return { verdict: 'ok', afterSeq: after.seq, afterHash: after.hash, message: 'waited' };
    }
    if (action.kind === 'screenshot') {
      return { verdict: 'ok', afterSeq: before.seq, afterHash: before.hash, message: 'observed' };
    }

    // Authority gate for every mutating action.
    const decision = authorize({ surface: 'agent-tool', action: `computer.${action.kind}`, ownerVerified: this.o.ownerVerified });
    if (!decision.proceed) {
      return { verdict: 'refused', afterSeq: before.seq, afterHash: before.hash, message: `refused: ${decision.reason}` };
    }

    // Resolve target for pointer actions.
    let grounded: Grounded | undefined;
    const needsPoint = action.kind === 'click' || action.kind === 'double_click' || action.kind === 'move' || action.kind === 'scroll';
    if (needsPoint && action.target) {
      grounded = await this.o.grounding.resolve(action.target, before);
      if (grounded.x < 0 || grounded.confidence <= 0) {
        return { verdict: 'grounding-failed', grounded, afterSeq: before.seq, afterHash: before.hash, message: grounded.error ?? 'grounding failed' };
      }
    }

    // Inject (structured/AX first when possible, pixel fallback).
    const inj = await this.inject(action, grounded);
    if (!inj.success) {
      return { verdict: 'error', grounded, afterSeq: before.seq, afterHash: before.hash, message: inj.error ?? 'injection failed' };
    }

    // Settle, then observe + verify.
    await new Promise((r) => setTimeout(r, this.settleMs));
    const after = await this.o.perception.capture(this.o.display);
    this.o.perception.invalidate(this.o.display);
    const ok = this.verify(action.expect ?? { changed: true }, before, after);
    return {
      verdict: ok ? 'ok' : 'expectation-failed',
      grounded,
      structured: inj.structured,
      afterSeq: after.seq,
      afterHash: after.hash,
      message: ok ? 'ok' : `expectation not met: ${JSON.stringify(action.expect ?? { changed: true })}`,
    };
  }

  private async inject(action: Action, grounded?: Grounded): Promise<{ success: boolean; error?: string; structured?: boolean }> {
    const s = this.o.sink;
    // API-first: for a click on a grounded AX element, try the structured actor.
    if (
      (action.kind === 'click' || action.kind === 'double_click') &&
      this.o.structuredActor &&
      grounded?.element &&
      (grounded.source === 'element-index' || grounded.source === 'ax-text')
    ) {
      try {
        const handled = await this.o.structuredActor(grounded, action);
        if (handled) return { success: true, structured: true };
      } catch {
        /* fall through to pixel */
      }
    }
    switch (action.kind) {
      case 'click':
        return s.click(grounded!.x, grounded!.y);
      case 'double_click':
        return s.doubleClick ? s.doubleClick(grounded!.x, grounded!.y) : s.click(grounded!.x, grounded!.y);
      case 'move':
        return s.move ? s.move(grounded!.x, grounded!.y) : { success: true };
      case 'type':
        return s.type(action.text ?? '');
      case 'key':
        return s.key(action.key ?? '');
      case 'scroll':
        return s.scroll(action.direction ?? 'down');
      case 'focus_window':
        return s.focusWindow ? s.focusWindow(action.window ?? '') : { success: false, error: 'focus unsupported' };
      default:
        return { success: false, error: `unknown action kind ${action.kind}` };
    }
  }

  /** Check an expectation against before/after snapshots. */
  private verify(expect: Expectation, before: Snapshot, after: Snapshot): boolean {
    // All present fields are ANDed. An empty expectation defaults to {changed:true}.
    if (expect.changed && !PerceptionService.changed(before, after)) return false;
    if (expect.appears) {
      const q = expect.appears.toLowerCase();
      if (!after.elements.some((e) => e.name.toLowerCase().includes(q))) return false;
    }
    if (expect.disappears) {
      const q = expect.disappears.toLowerCase();
      if (after.elements.some((e) => e.name.toLowerCase().includes(q))) return false;
    }
    if (expect.windowTitle) {
      const q = expect.windowTitle.toLowerCase();
      if (!after.windows.some((w) => w.title.toLowerCase().includes(q))) return false;
    }
    return true;
  }

  private mk(
    action: Action,
    verdict: Verdict,
    grounded: Grounded | undefined,
    recovery: RecoveryRung[],
    beforeSeq: number,
    afterSeq: number,
    start: number,
    message: string,
    structured?: boolean,
  ): StepResult {
    return { action, verdict, grounded, structured, recovery, beforeSeq, afterSeq, durationMs: Date.now() - start, message };
  }

  private async journal(subgoal: string, step: StepResult, beforeHash?: string, afterHash?: string): Promise<void> {
    if (this.o.journal) await this.o.journal.record(subgoal, step, beforeHash, afterHash);
  }

  /**
   * Speculative BATCH execution (the UFO2/OpenAI speed pattern): run a run of
   * actions with ONE perception at the start and verify only at the actions that
   * carry an explicit `expect` (checkpoints). This slashes perception round-trips
   * versus per-action verification. It aborts immediately on an injection failure
   * or a failed checkpoint expectation — so it never silently drifts past a
   * broken step. Actions are grounded against the batch-start snapshot; put an
   * `expect` on any action whose target depends on a prior action's effect.
   *
   * No per-action recovery ladder (that's what run()/step() are for) — a failed
   * checkpoint returns control to the caller to re-plan or fall back to run().
   */
  async runBatch(plan: ActionPlan): Promise<PlanResult> {
    const steps: StepResult[] = [];
    const before = await this.o.perception.capture(this.o.display);
    let checkpoint = before;

    for (const action of plan.actions) {
      const start = Date.now();
      // Authority gate.
      const decision = authorize({ surface: 'agent-tool', action: `computer.${action.kind}`, ownerVerified: this.o.ownerVerified });
      if (!decision.proceed) {
        steps.push(this.mk(action, 'refused', undefined, [], before.seq, before.seq, start, `refused: ${decision.reason}`));
        return { subgoal: plan.subgoal, success: false, steps, reason: 'refused' };
      }

      // Ground against the batch-start snapshot (speculative).
      let grounded: Grounded | undefined;
      const needsPoint = action.kind === 'click' || action.kind === 'double_click' || action.kind === 'move' || action.kind === 'scroll';
      if (needsPoint && action.target) {
        grounded = await this.o.grounding.resolve(action.target, before);
        if (grounded.x < 0 || grounded.confidence <= 0) {
          steps.push(this.mk(action, 'grounding-failed', grounded, [], before.seq, before.seq, start, grounded.error ?? 'grounding failed'));
          return { subgoal: plan.subgoal, success: false, steps, reason: 'grounding-failed' };
        }
      }

      if (action.kind !== 'wait' && action.kind !== 'screenshot') {
        const inj = await this.inject(action, grounded);
        if (!inj.success) {
          steps.push(this.mk(action, 'error', grounded, [], before.seq, before.seq, start, inj.error ?? 'injection failed'));
          return { subgoal: plan.subgoal, success: false, steps, reason: 'injection-failed' };
        }
        // Only pay for a perception + verification at explicit checkpoints.
        if (action.expect) {
          await new Promise((r) => setTimeout(r, this.settleMs));
          const after = await this.o.perception.capture(this.o.display);
          this.o.perception.invalidate(this.o.display);
          const ok = this.verify(action.expect, checkpoint, after);
          steps.push(this.mk(action, ok ? 'ok' : 'expectation-failed', grounded, [], checkpoint.seq, after.seq, start, ok ? 'ok' : 'checkpoint failed', inj.structured));
          if (!ok) return { subgoal: plan.subgoal, success: false, steps, reason: 'expectation-failed' };
          checkpoint = after;
        } else {
          steps.push(this.mk(action, 'ok', grounded, [], before.seq, before.seq, start, 'batched (no checkpoint)', inj.structured));
        }
      } else if (action.kind === 'wait') {
        await new Promise((r) => setTimeout(r, action.ms ?? 250));
        steps.push(this.mk(action, 'ok', undefined, [], before.seq, before.seq, start, 'waited'));
      }
    }
    return { subgoal: plan.subgoal, success: true, steps };
  }
}
