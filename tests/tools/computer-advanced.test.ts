/**
 * @file computer-advanced.test.ts
 * @description Phase 5 — PRM scoring, best-of-N orchestration (success lift +
 * judge), execution checkpoint/rollback, and MCP export contract.
 * Deterministic, no display.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreTrajectory, scorePlan } from '../../src/core/tools/builtin/computer-use/core/scoring.js';
import { runBestOfN } from '../../src/core/tools/builtin/computer-use/core/orchestrator.js';
import { PlanRunStore, type PlanRunState } from '../../src/core/tools/builtin/computer-use/core/plan-runner.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { registerComputerUseTools, computerUseFamily } from '../../src/core/tools/builtin/computer-use/index.js';
import type { ActionExecutor } from '../../src/core/tools/builtin/computer-use/core/executor.js';
import type { PlanResult, StepResult, Action, ActionPlan } from '../../src/core/tools/builtin/computer-use/core/types.js';

function step(verdict: StepResult['verdict'], kind: Action['kind'] = 'click', structured = false, recovery: string[] = []): StepResult {
  return { action: { kind }, verdict, structured, recovery: recovery as never, beforeSeq: 0, afterSeq: 1, durationMs: 1, message: verdict };
}

describe('PRM trajectory scoring', () => {
  it('rewards completion + structured actions and penalises recovery/failure', () => {
    const clean = scoreTrajectory([step('ok', 'click', true), step('ok', 'type')]);
    const churny = scoreTrajectory([step('ok', 'click', false, ['reground', 'replan']), step('expectation-failed', 'type')]);
    expect(clean.fullySucceeded).toBe(true);
    expect(clean.structuredFraction).toBe(1);
    expect(clean.score).toBeGreaterThan(churny.score);
    expect(churny.fullySucceeded).toBe(false);
  });

  it('scorePlan demotes a failed plan below a comparable success', () => {
    const ok: PlanResult = { subgoal: 'g', success: true, steps: [step('ok'), step('ok')] };
    const bad: PlanResult = { subgoal: 'g', success: false, steps: [step('ok'), step('expectation-failed')] };
    expect(scorePlan(ok).score).toBeGreaterThan(scorePlan(bad).score);
  });
});

describe('best-of-N orchestration', () => {
  const plan: ActionPlan = { subgoal: 'hard task', actions: [{ kind: 'click', target: { text: 'Go' } }] };

  function execReturning(result: PlanResult): ActionExecutor {
    return { async run() { return result; }, async runBatch() { return result; } } as unknown as ActionExecutor;
  }

  it('lifts success: 2 failing attempts + 1 succeeding → best is the success', async () => {
    const outcomes: PlanResult[] = [
      { subgoal: 'hard task', success: false, steps: [step('grounding-failed')] },
      { subgoal: 'hard task', success: false, steps: [step('expectation-failed')] },
      { subgoal: 'hard task', success: true, steps: [step('ok', 'click', true)] },
    ];
    const disposed: number[] = [];
    const res = await runBestOfN({
      n: 3,
      plan,
      provision: async (i) => ({ display: `:mock${i}`, dispose: async () => { disposed.push(i); } }),
      makeExecutor: (_d, i) => execReturning(outcomes[i]),
    });
    expect(res.anySucceeded).toBe(true);
    expect(res.best?.result.success).toBe(true);
    expect(res.best?.index).toBe(2);
    expect(res.attempts.length).toBe(3);
    expect(disposed.sort()).toEqual([0, 1, 2]); // every session disposed
  });

  it('reports no success when all attempts fail', async () => {
    const res = await runBestOfN({
      n: 2,
      plan,
      provision: async (i) => ({ display: `:m${i}`, dispose: async () => {} }),
      makeExecutor: () => execReturning({ subgoal: 'hard task', success: false, steps: [step('grounding-failed')] }),
    });
    expect(res.anySucceeded).toBe(false);
  });

  it('isolates a throwing attempt without sinking the batch', async () => {
    const res = await runBestOfN({
      n: 2,
      plan,
      provision: async (i) => ({ display: `:m${i}`, dispose: async () => {} }),
      makeExecutor: (_d, i) => (i === 0 ? ({ async run() { throw new Error('boom'); } } as unknown as ActionExecutor) : execReturning({ subgoal: 'hard task', success: true, steps: [step('ok')] })),
    });
    expect(res.anySucceeded).toBe(true);
    expect(res.attempts.find((a) => a.index === 0)?.error).toMatch(/boom/);
  });
});

describe('execution checkpoint / rollback', () => {
  let dir: string;
  let store: PlanRunStore;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cu-ckpt-')); store = new PlanRunStore(dir); });

  it('restores a run to a labelled checkpoint cursor', async () => {
    const base: PlanRunState = {
      runId: 'r', sessionId: 's', display: ':t', subgoal: 'g',
      actions: [{ kind: 'wait' }, { kind: 'wait' }, { kind: 'wait' }, { kind: 'wait' }, { kind: 'wait' }],
      cursor: 2, status: 'running', results: [step('ok'), step('ok')], createdAt: 1, updatedAt: 1,
    };
    await store.save(base);
    await store.checkpoint('r', 'mid');
    // advance then fail
    base.cursor = 4; base.status = 'failed'; await store.save(base);
    const restored = await store.restore('r', 'mid');
    expect(restored.cursor).toBe(2);
    expect(restored.status).toBe('running');
    const reloaded = await store.load('r');
    expect(reloaded?.cursor).toBe(2);
  });
});

describe('MCP export contract', () => {
  it('read-only computer tools auto-expose; mutating ones require the allowlist', () => {
    const reg = new ToolRegistry();
    registerComputerUseTools(reg);
    // The MCP loopback exposes non-destructive tools by default; destructive ones
    // need SUDO_MCP_EXPOSE_TOOLS. Assert the safety classification that drives it.
    const readOnly = computerUseFamily.filter((t) => (t.safety ?? 'readonly') !== 'destructive').map((t) => t.name).sort();
    expect(readOnly).toEqual(['computer.perceive', 'computer.screenshot']);
    // Every tool emits a valid LLM/MCP function schema (name + object params).
    const schema = reg.getSchemaForLLM();
    const computerSchemas = schema.filter((s) => s.function.name.startsWith('computer.'));
    expect(computerSchemas.length).toBe(computerUseFamily.length);
    for (const s of computerSchemas) {
      expect(s.type).toBe('function');
      expect(s.function.parameters).toBeTypeOf('object');
    }
  });
});
