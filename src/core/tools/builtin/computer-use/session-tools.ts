/**
 * @file session-tools.ts
 * @description Agent-facing long-horizon surface: `computer.session` (manage
 * desktop sessions) and `computer.run_plan` (drive a verified, durable,
 * skill-aware action plan). This wires the Phase 1 engine to the agent and the
 * Phase 2 durability/skill layers.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import type { Action, ActionPlan } from './core/types.js';
import { PerceptionService } from './core/perception.js';
import { GroundingResolver } from './core/grounding.js';
import { ActionExecutor } from './core/executor.js';
import { ActionJournal } from './core/journal.js';
import { PlanRunStore, PlanRunner, type PlanRunState } from './core/plan-runner.js';
import { SkillStore } from './core/skill-store.js';
import { createEphemeralSession, attachSession, type Session } from './core/session.js';
import { resolveDisplay } from './perceive.js';
import { createDriver } from './core/driver.js';
import { driverSink, driverStructuredActor } from './core/driver-adapters.js';

const log = createLogger('tool:computer-session');
const KILL_SWITCH_ENV = 'SUDO_COMPUTER_USE_DISABLE';

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

interface Handle {
  handle: string;
  session: Session;
}

class SessionRegistry {
  private readonly sessions = new Map<string, Handle>();
  private counter = 0;

  async startEphemeral(width?: number, height?: number): Promise<Handle> {
    const session = await createEphemeralSession({ width, height });
    const handle = `cu-eph-${++this.counter}-${session.display.replace(':', '')}`;
    const h = { handle, session };
    this.sessions.set(handle, h);
    return h;
  }

  attach(display: string): Handle {
    const session = attachSession(display);
    const handle = `cu-att-${display.replace(':', '')}`;
    const h = { handle, session };
    this.sessions.set(handle, h);
    return h;
  }

  get(handle: string): Handle | undefined {
    return this.sessions.get(handle);
  }

  list(): Array<{ handle: string; display: string; kind: string }> {
    return [...this.sessions.values()].map((h) => ({ handle: h.handle, display: h.session.display, kind: h.session.kind }));
  }

  async dispose(handle: string): Promise<boolean> {
    const h = this.sessions.get(handle);
    if (!h) return false;
    await h.session.dispose();
    this.sessions.delete(handle);
    return true;
  }
}

const registry = new SessionRegistry();

/** Test seam. */
export function __sessionRegistryForTest(): SessionRegistry {
  return registry;
}

// ---------------------------------------------------------------------------
// Action coercion (defensive parse of LLM-supplied plan)
// ---------------------------------------------------------------------------

const ACTION_KINDS = new Set(['click', 'double_click', 'type', 'key', 'scroll', 'move', 'wait', 'focus_window', 'screenshot']);

function coerceAction(raw: unknown): Action | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = String(o['kind'] ?? '');
  if (!ACTION_KINDS.has(kind)) return null;
  const a: Action = { kind: kind as Action['kind'] };
  if (o['text'] !== undefined) a.text = String(o['text']);
  if (o['key'] !== undefined) a.key = String(o['key']);
  if (o['direction'] === 'up' || o['direction'] === 'down') a.direction = o['direction'];
  if (typeof o['ms'] === 'number') a.ms = o['ms'];
  if (o['window'] !== undefined) a.window = String(o['window']);
  if (o['label'] !== undefined) a.label = String(o['label']);
  if (o['target'] && typeof o['target'] === 'object') {
    const t = o['target'] as Record<string, unknown>;
    a.target = {};
    if (typeof t['elementIndex'] === 'number') a.target.elementIndex = t['elementIndex'];
    if (t['text'] !== undefined) a.target.text = String(t['text']);
    if (t['role'] !== undefined) a.target.role = String(t['role']);
    if (typeof t['x'] === 'number') a.target.x = t['x'];
    if (typeof t['y'] === 'number') a.target.y = t['y'];
  }
  if (o['expect'] && typeof o['expect'] === 'object') {
    const e = o['expect'] as Record<string, unknown>;
    a.expect = {};
    if (typeof e['changed'] === 'boolean') a.expect.changed = e['changed'];
    if (e['appears'] !== undefined) a.expect.appears = String(e['appears']);
    if (e['disappears'] !== undefined) a.expect.disappears = String(e['disappears']);
    if (e['windowTitle'] !== undefined) a.expect.windowTitle = String(e['windowTitle']);
    if (e['describe'] !== undefined) a.expect.describe = String(e['describe']);
  }
  return a;
}

// ---------------------------------------------------------------------------
// computer.session
// ---------------------------------------------------------------------------

export const sessionTool: ToolDefinition = {
  name: 'computer.session',
  description:
    'Manage desktop sessions for computer use. start (ephemeral, isolated Xvfb desktop — safest for autonomous work), attach (an existing display like :10), list, or dispose. Returns a session handle to pass to computer.run_plan.',
  category: 'computer',
  safety: 'destructive',
  timeout: 20_000,
  parameters: {
    action: { type: 'string', required: true, enum: ['start', 'attach', 'list', 'dispose'], description: 'Session action.' },
    handle: { type: 'string', required: false, description: 'Session handle (for dispose).' },
    display: { type: 'string', required: false, description: 'Display to attach (for attach), e.g. ":10".' },
    width: { type: 'number', required: false, description: 'Ephemeral session width (default 1280).' },
    height: { type: 'number', required: false, description: 'Ephemeral session height (default 800).' },
  },
  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    if (process.env[KILL_SWITCH_ENV] === '1') return { success: false, output: `computer: disabled (${KILL_SWITCH_ENV}=1)` };
    const action = params['action'];
    try {
      if (action === 'start') {
        const h = await registry.startEphemeral(
          typeof params['width'] === 'number' ? (params['width'] as number) : undefined,
          typeof params['height'] === 'number' ? (params['height'] as number) : undefined,
        );
        return { success: true, output: `session ${h.handle} on ${h.session.display} (ephemeral)`, data: { handle: h.handle, display: h.session.display } };
      }
      if (action === 'attach') {
        const h = registry.attach(resolveDisplay(params['display']));
        return { success: true, output: `attached ${h.handle} on ${h.session.display}`, data: { handle: h.handle, display: h.session.display } };
      }
      if (action === 'list') {
        return { success: true, output: `${registry.list().length} sessions`, data: { sessions: registry.list() } };
      }
      if (action === 'dispose') {
        const ok = await registry.dispose(String(params['handle'] ?? ''));
        return { success: ok, output: ok ? 'disposed' : 'handle not found' };
      }
      return { success: false, output: 'computer.session: action must be start|attach|list|dispose' };
    } catch (e) {
      return { success: false, output: `computer.session failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

// ---------------------------------------------------------------------------
// computer.run_plan
// ---------------------------------------------------------------------------

const grounding = new GroundingResolver();
const planStore = new PlanRunStore();
const skillStore = new SkillStore();

function resolveSessionDisplay(handleParam: unknown): { display: string; shared: boolean } {
  if (typeof handleParam === 'string' && handleParam) {
    const h = registry.get(handleParam);
    if (h) return { display: h.session.display, shared: h.session.kind === 'attached' };
  }
  // No handle → the active/attached display (shared owner desktop).
  return { display: resolveDisplay(undefined), shared: true };
}

export const runPlanTool: ToolDefinition = {
  name: 'computer.run_plan',
  description:
    'Execute a multi-step GUI action plan with verification and recovery. Each action grounds its target (by accessibility element index/text or coordinates), runs, then checks an expectation before continuing; failures trigger a recovery ladder. The run is durable (survives restart — resume with its runId) and can reuse/save a named skill. Perceive first with computer.perceive to choose targets.',
  category: 'computer',
  safety: 'destructive',
  timeout: 300_000,
  parameters: {
    subgoal: { type: 'string', required: true, description: 'What this plan accomplishes (also the skill key).' },
    actions: {
      type: 'array',
      required: false,
      description: 'Ordered actions. Each: {kind, target?:{elementIndex|text|role|x|y}, text?, key?, direction?, window?, ms?, expect?:{changed?,appears?,disappears?,windowTitle?}, label?}. Omit to reuse a saved skill matching the subgoal.',
      items: { type: 'object', description: 'An action.' },
    },
    session: { type: 'string', required: false, description: 'Session handle from computer.session (default: the active display).' },
    resume: { type: 'string', required: false, description: 'Resume a previous runId instead of starting fresh.' },
    use_skill: { type: 'boolean', required: false, description: 'Reuse a saved skill matching the subgoal when no actions are given (default true).' },
    save_skill: { type: 'boolean', required: false, description: 'Induce/update a skill from this plan on success (default true).' },
    mode: { type: 'string', required: false, enum: ['verified', 'batch'], description: '"verified" (default): per-action verify + recovery, durable/resumable. "batch": speculative — one perception, verify only at actions carrying an expect; faster, not resumable.' },
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (process.env[KILL_SWITCH_ENV] === '1') return { success: false, output: `computer: disabled (${KILL_SWITCH_ENV}=1)` };

    const { display, shared } = resolveSessionDisplay(params['session']);
    const journal = new ActionJournal(ctx.sessionId || 'default', display);

    // Build the platform driver for this run. `guardProtected` is only honoured
    // by the X11 driver (opts ignored elsewhere) — it protects the shared owner
    // desktop from synthetic input into Terminal/Claude windows.
    const driver = await createDriver(undefined, { guardProtected: shared });
    const perception = new PerceptionService({ accessibility: true, driver });
    const sink = driverSink(driver, display);
    const structuredActor = driverStructuredActor(driver, display);

    const makeExecutor = (state: PlanRunState) =>
      new ActionExecutor({
        sessionId: state.sessionId,
        display: state.display,
        perception,
        grounding,
        sink,
        ownerVerified: ctx.isOwner === true,
        journal,
        structuredActor,
      });

    const runner = new PlanRunner({ store: planStore, makeExecutor });

    // Resume path.
    if (typeof params['resume'] === 'string' && params['resume']) {
      try {
        const r = await runner.resume(params['resume']);
        return { success: r.status === 'done', output: `resumed ${r.runId}: ${r.status} (${r.completed}/${r.total})`, data: r };
      } catch (e) {
        return { success: false, output: `resume failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }

    const subgoal = String(params['subgoal'] ?? '').trim();
    if (!subgoal) return { success: false, output: 'computer.run_plan: subgoal is required.' };

    // Resolve actions: explicit, else a matching skill.
    let actions: Action[] = [];
    let usedSkillId: string | undefined;
    const rawActions = params['actions'];
    if (Array.isArray(rawActions) && rawActions.length) {
      actions = rawActions.map(coerceAction).filter((a): a is Action => a !== null);
    } else if (params['use_skill'] !== false) {
      const skill = await skillStore.find(subgoal);
      if (skill) {
        actions = skill.actions;
        usedSkillId = skill.id;
        log.info({ skill: skill.id, subgoal }, 'reusing skill for plan');
      }
    }
    if (!actions.length) {
      return { success: false, output: 'computer.run_plan: no actions supplied and no matching skill found.' };
    }

    const plan: ActionPlan = { subgoal, actions };

    // Batch (speculative) mode: fast, non-durable, one-shot.
    if (params['mode'] === 'batch') {
      const exec = makeExecutor({ runId: 'batch', sessionId: ctx.sessionId || 'default', display, subgoal, actions, cursor: 0, status: 'running', results: [], createdAt: Date.now(), updatedAt: Date.now() });
      const pr = await exec.runBatch(plan);
      const structuredCount = pr.steps.filter((s) => s.structured).length;
      const pointerCount = pr.steps.filter((s) => ['click', 'double_click', 'move', 'scroll'].includes(s.action.kind)).length;
      if (usedSkillId) await skillStore.recordUse(usedSkillId, pr.success);
      if (pr.success && params['save_skill'] !== false && !usedSkillId) await skillStore.induce(subgoal, actions);
      return {
        success: pr.success,
        output: `plan "${subgoal}" (batch) ${pr.success ? 'done' : 'failed'} (${pr.steps.length} steps, ${structuredCount}/${pointerCount} pointer steps via structured AX)${usedSkillId ? ' [skill reused]' : ''}`,
        data: { success: pr.success, steps: pr.steps.length, structuredCount, pointerCount, reason: pr.reason, usedSkill: usedSkillId },
      };
    }

    const runId = `run-${(ctx.sessionId || 'x').slice(0, 8)}-${Date.now().toString(36)}`;
    const result = await runner.start({ runId, sessionId: ctx.sessionId || 'default', display, subgoal, actions });

    if (usedSkillId) await skillStore.recordUse(usedSkillId, result.status === 'done');
    if (result.status === 'done' && params['save_skill'] !== false && !usedSkillId) {
      await skillStore.induce(subgoal, actions);
    }

    return {
      success: result.status === 'done',
      output: `plan "${subgoal}" ${result.status} (${result.completed}/${result.total} steps)${usedSkillId ? ' [skill reused]' : ''}. runId=${result.runId}`,
      data: { ...result, usedSkill: usedSkillId, planSteps: plan.actions.length },
    };
  },
};
